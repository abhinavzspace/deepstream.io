var C = require( '../constants/constants' ),
	messageParser = require( './message-parser' ),
	SocketWrapper = require( './socket-wrapper' ),
	engine = require('engine.io'),
	TcpEndpoint = require( '../tcp/tcp-endpoint' ),
	events = require( 'events' ),
	util = require( 'util' ),
	https = require('https'),
	http = require('http'),
	ENGINE_IO = 0,
	TCP_ENDPOINT = 1,
	READY_STATE_CLOSED = 'closed';

/**
 * This is the frontmost class of deepstream's message pipeline. It receives
 * connections and authentication requests, authenticates sockets and
 * forwards messages it receives from authenticated sockets.
 *
 * @constructor
 * 
 * @extends events.EventEmitter
 * 
 * @param {Object} options the extended default options
 * @param {Function} readyCallback will be invoked once both the engineIo and the tcp connection are established
 */
var ConnectionEndpoint = function( options, readyCallback ) {
	this._options = options;
	this._readyCallback = readyCallback;

	if( !options.webServerEnabled && !options.tcpServerEnabled ) {
		throw new Error( 'Can\'t start deepstream with both webserver and tcp disabled' );
	}

	if( options.webServerEnabled ) {
		// Initialise engine.io's server - a combined http and websocket server for browser connections
		this._engineIoReady = false;
		this._engineIoServerClosed = false;

		if( this._options.httpServer ) {
			this._server = this._options.httpServer;
			this._engineIo = engine.attach( this._server, { path: this._options.urlPath });
		} else {
			this._server = this._createHttpServer();
			this._server.listen( this._options.port, this._options.host );
			this._engineIo = engine.attach( this._server );
		}

		if( this._server.listening ) {
			this._checkReady( ENGINE_IO );
		} else {
			this._server.once( 'listening', this._checkReady.bind( this, ENGINE_IO ) );
  		}

		this._engineIo.on( 'error', this._onError.bind( this ) );
		this._engineIo.on( 'connection', this._onConnection.bind( this, ENGINE_IO ) );
	}

	if( options.tcpServerEnabled ) {
		// Initialise a tcp server to facilitate fast and compatible communication with backend systems
		this._tcpEndpointReady = false;
		this._tcpEndpoint = new TcpEndpoint( options, this._checkReady.bind( this, TCP_ENDPOINT ) );
		this._tcpEndpoint.on( 'error', this._onError.bind( this ) );
		this._tcpEndpoint.on( 'connection', this._onConnection.bind( this, TCP_ENDPOINT ) );
	}	

	this._timeout = null;
	this._msgNum = 0;
	this._authenticatedSockets = [];
};

util.inherits( ConnectionEndpoint, events.EventEmitter );

/**
 * Called for every message that's received
 * from an authenticated socket
 *
 * This method will be overridden by an external class and is used instead
 * of an event emitter to improve the performance of the messaging pipeline
 *
 * @param   {SocketWrapper} socketWrapper
 * @param   {String} message the raw message as sent by the client
 *
 * @public
 * 
 * @returns {void}
 */
ConnectionEndpoint.prototype.onMessage = function( socketWrapper, message ) {};

/**
 * Closes both the engine.io connection and the tcp connection. The ConnectionEndpoint
 * will emit a close event once both are succesfully shut down
 * 
 * @public
 * @returns {void}
 */
ConnectionEndpoint.prototype.close = function() {
	// Close the engine.io server
	if( this._engineIo ) {
		this._closeEngineIoServer();
	}
	
	// Close the tcp server
	if( this._tcpEndpoint ) {
		this._closeTcpServer();
	}
};

/**
 * Closes the engine.io and subsequently http server
 * 
 * TODO: Make sure that engine.io and the http server's
 * clode events align and potentially don't close
 * the http server if it's provided as an external parameter
 * and might be used by express etc...
 *
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._closeEngineIoServer = function() {
	this._engineIo.removeAllListeners( 'connection' );
	for( var i = 0; i < this._engineIo.clients.length; i++ ) {
		if( this._engineIo.clients[ i ].readyState !== READY_STATE_CLOSED ) {
			this._engineIo.clients[ i ].once( 'close', this._checkClosed.bind( this ) );
		}
	}
	this._engineIo.close();
	this._server.close( function(){ 
		this._engineIoServerClosed = true;
		this._checkClosed();
	}.bind( this ));
};

/**
 * Issues a close command to the tcp server and subscribes
 * to its close event
 *
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._closeTcpServer = function() {
	this._tcpEndpoint.removeAllListeners( 'connection' );
	this._tcpEndpoint.on( 'close', this._checkClosed.bind( this ) );
	this._tcpEndpoint.close();
};
 
/**
 * Creates an HTTP or HTTPS server for engine.io to attach itself to,
 * depending on the options the client configured
 * 
 * @private
 * @returns {http.HttpServer || http.HttpsServer}
 */
ConnectionEndpoint.prototype._createHttpServer = function() {
	if( this._isHttpsServer() ) {

		var httpsOptions = {
			key: this._options.sslKey,
			cert: this._options.sslCert
		};

		if ( this._options.sslCa ) {
			httpsOptions.ca = this._options.sslCa;
		}

		return https.createServer( httpsOptions );
	} else {
		return http.createServer();
	}
};

/**
 * Called whenever either the tcp server itself or one of its sockets
 * is closed. Once everything is closed it will emit a close event
 * 
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._checkClosed = function() {
	if( this._tcpEndpoint && this._tcpEndpoint.isClosed === false ) {
		return;	
	}

	if( this._engineIo && this._engineIoServerClosed === false ) {
		return;
	}

	for( var i = 0; this._engineIo && i < this._engineIo.clients.length; i++ ) {
		if( this._engineIo.clients[ i ].readyState !== READY_STATE_CLOSED ) {
			return;
		}
	}
	
	this.emit( 'close' );
};

/**
 * Callback for 'connection' event. Receives
 * a connected socket, wraps it in a SocketWrapper and
 * subscribes to authentication messages
 *
 * @param {Number} endpoint 
 * @param {TCPSocket|Engine.io} socket
 *
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._onConnection = function( endpoint, socket ) {
	var socketWrapper = new SocketWrapper( socket, this._options ),
		handshakeData = socketWrapper.getHandshakeData(),
		logMsg;

	if( endpoint === ENGINE_IO ) {
		logMsg = 'from ' + handshakeData.referer + ' (' + handshakeData.remoteAddress + ')' + ' via engine.io';
	} else {
		logMsg = 'from ' + handshakeData.remoteAddress + ' via tcp';
	}

	this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.INCOMING_CONNECTION, logMsg );
	socketWrapper.authCallBack = this._authenticateConnection.bind( this, socketWrapper );
	socket.on( 'message', socketWrapper.authCallBack );
};

/**
 * Callback for the first message that's received from the socket.
 * This is expected to be an auth-message. This method makes sure that's
 * the case and - if so - forwards it to the permission handler for authentication
 *
 * @param   {SocketWrapper} socketWrapper
 * @param   {String} authMsg
 *
 * @private
 *
 * @returns {void}
 */
ConnectionEndpoint.prototype._authenticateConnection = function( socketWrapper, authMsg ) {
	var msg = messageParser.parse( authMsg )[ 0 ],
		logMsg,
		authData,
		errorMsg;

	/**
	 * Log the authentication attempt
	 */
	logMsg = socketWrapper.getHandshakeData().remoteAddress  + ': ' + authMsg;
	this._options.logger.log( C.LOG_LEVEL.DEBUG, C.EVENT.AUTH_ATTEMPT, logMsg );

	/**
	 * Ensure the message is a valid authentication message
	 */
	if( !msg || msg.topic !== C.TOPIC.AUTH || msg.action !== C.ACTIONS.REQUEST || msg.data.length !== 1 ) {
		errorMsg = this._options.logInvalidAuthData === true ? authMsg : '';
		this._sendInvalidAuthMsg( socketWrapper, errorMsg );
		return;
	}

	/**
	 * Ensure the authentication data is valid JSON
	 */
	try{
		authData = JSON.parse( msg.data[ 0 ] );
	} catch( e ) {
		errorMsg = 'Error parsing auth message';

		if( this._options.logInvalidAuthData === true ) {
		 	errorMsg += ' "' + authMsg + '": ' + e.toString();
		}

		this._sendInvalidAuthMsg( socketWrapper, errorMsg );
		return;
	}
	
	/**
	 * Forward for authentication
	 */
	this._options.permissionHandler.isValidUser( 
		socketWrapper.getHandshakeData(), 
		authData,
		this._processAuthResult.bind( this, authData, socketWrapper ) 
	);
};

/**
 * Will be called for syntactically incorrect auth messages. Logs
 * the message, sends an error to the client and closes the socket
 *
 * @param   {SocketWrapper} socketWrapper
 * @param   {String} msg the raw message as sent by the client
 *
 * @private
 *
 * @returns {void}
 */
ConnectionEndpoint.prototype._sendInvalidAuthMsg = function( socketWrapper, msg ) {
	this._options.logger.log( C.LOG_LEVEL.WARN, C.EVENT.INVALID_AUTH_MSG, this._options.logInvalidAuthData ? msg : '' );
	socketWrapper.sendError( C.TOPIC.AUTH, C.EVENT.INVALID_AUTH_MSG, 'invalid authentication message' );
	socketWrapper.destroy();
};

/**
 * Callback for succesfully validated sockets. Removes
 * all authentication specific logic and registeres the
 * socket with the authenticated sockets
 *
 * @param   {SocketWrapper} socketWrapper
 * @param   {String} username
 *
 * @private
 *
 * @returns {void}
 */
ConnectionEndpoint.prototype._registerAuthenticatedSocket  = function( socketWrapper, username ) {
	socketWrapper.socket.removeListener( 'message', socketWrapper.authCallBack );
	socketWrapper.socket.once( 'close', this._onSocketClose.bind( this, socketWrapper ) );
	socketWrapper.socket.on( 'message', function( msg ){ this.onMessage( socketWrapper, msg ); }.bind( this ));
	socketWrapper.user = username;
	socketWrapper.sendMessage( C.TOPIC.AUTH, C.ACTIONS.ACK );
	this._authenticatedSockets.push( socketWrapper );
	this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.AUTH_SUCCESSFUL, username );
};

/**
 * Callback for invalid credentials. Will notify the client
 * of the invalid auth attempt. If the number of invalid attempts
 * exceed the threshold specified in options.maxAuthAttempts
 * the client will be notified and the socket destroyed.
 *
 * @param   {Object} authData      the (invalid) auth data
 * @param   {SocketWrapper} socketWrapper
 *
 * @private
 *
 * @returns {void}
 */
ConnectionEndpoint.prototype._processInvalidAuth = function( authError, authData, socketWrapper ) {
	var logMsg = 'invalid authentication data';

	if( this._options.logInvalidAuthData === true ) {
		logMsg += ': ' + JSON.stringify( authData );
	}

	this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.INVALID_AUTH_DATA, logMsg );
	socketWrapper.sendError( C.TOPIC.AUTH, C.EVENT.INVALID_AUTH_DATA, authError || 'invalid authentication data' );
	socketWrapper.authAttempts++;
	
	if( socketWrapper.authAttempts >= this._options.maxAuthAttempts ) {
		this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.TOO_MANY_AUTH_ATTEMPTS, 'too many authentication attempts' );
		socketWrapper.sendError( C.TOPIC.AUTH, C.EVENT.TOO_MANY_AUTH_ATTEMPTS, 'too many authentication attempts' );
		socketWrapper.destroy();
	}
};

/**
 * Callback for the results returned by the permissionHandler
 *
 * @param   {Object} authData
 * @param   {SocketWrapper} socketWrapper
 * @param   {String} authError     String or null if auth succesfull
 * @param   {String} username
 *
 * @private
 * 
 * @returns {void}
 */
ConnectionEndpoint.prototype._processAuthResult = function( authData, socketWrapper, authError, username ) {
	if( authError === null ) {
		this._registerAuthenticatedSocket( socketWrapper, username );
	} else {
		this._processInvalidAuth( authError, authData, socketWrapper );
	}
};

/**
 * Called for the ready events of both the engine.io server and the tcp server.
 *
 * @param   {String} endpoint An endpoint constant
 *
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._checkReady = function( endpoint ) {
	var msg, address, tcpEndpointReady, engineIoReady;

	if( endpoint === ENGINE_IO ) {
		address = this._server.address();
		msg = 'Listening for browser connections on ' + address.address + ':' + address.port;
		this._engineIoReady = true;
	}

	if( endpoint === TCP_ENDPOINT ) {
		msg = 'Listening for tcp connections on ' + this._options.tcpHost + ':' + this._options.tcpPort;
		this._tcpEndpointReady = true;
	}

	this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.INFO, msg );

	tcpEndpointReady = !this._tcpEndpoint || this._tcpEndpointReady === true;
	engineIoReady = !this._engineIo || this._engineIoReady === true;

	if( tcpEndpointReady && engineIoReady ) {
		this._readyCallback();
	}
};

/**
 * Generic callback for connection errors. This will most often be called
 * if the configured port number isn't available
 *
 * @param   {String} error
 *
 * @private
 * @returns {void}
 */
ConnectionEndpoint.prototype._onError = function( error ) {
	this._options.logger.log( C.LOG_LEVEL.ERROR, C.EVENT.CONNECTION_ERROR, error );
};

/**
* Notifies the (optional) onClientDisconnect method of the permissionHandler
* that the specified client has disconnected
*
* @param {SocketWrapper} socketWrapper
*
* @private
* @returns {void}
*/
ConnectionEndpoint.prototype._onSocketClose = function( socketWrapper ) {
	if( this._options.permissionHandler.onClientDisconnect ) {
		this._options.permissionHandler.onClientDisconnect( socketWrapper.user );
	}
};

/**
* Returns whether or not sslKey and sslCert have been set to start a https server.
*
* @throws Will throw an error if only sslKey or sslCert have been specified
*
* @private
* @returns {boolean}
*/
ConnectionEndpoint.prototype._isHttpsServer = function( ) {
	var isHttps = false;
	if( this._options.sslKey || this._options.sslCert ) {
		if( !this._options.sslKey ) {
			throw new Error( 'Must also include sslKey in order to use HTTPS' );
		}
		if( !this._options.sslCert ) {
			throw new Error( 'Must also include sslCert in order to use HTTPS' );
		}
		isHttps = true;
	}
	return isHttps;
};

module.exports = ConnectionEndpoint;
