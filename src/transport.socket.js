/**
 * TCP socket based transport provider.
 * Both sides attempt to bind a port and see if the other side can reach them.
 */
var TCPTransport = function(dispatchEvent) {
  this.dispatchEvent = dispatchEvent;

  // Create a key for tiebreaking / identification.  
  var keyHolder = new Uint32Array(1);
  crypto.getRandomValues(keyHolder);
  this.key = keyHolder[0];

  this.socket = freedom['core.tcpsocket']();
  this.core = freedom.core();
  this.conn = null;
};

/**
 * Set up the transport provider, providing it a signalling channel.
 */
TCPTransport.prototype.setup = function(name, signalID) {
  this.name = name;

  return this.core.bindChannel(signalID).then(function(signallingChannel) {
    this.state = 'negotiating';
    signallingChannel.on('message', this.onSignallingMsg.bind(this));
    this.signallingChannel = signallingChannel;
    return this.socket.listen('0.0.0.0', 0)
  }.bind(this)).then(function() {
    this.socket.on('onConnection', this.onConnection.bind(this));
    return this.socket.getInfo();
  }.bind(this)).then(function(info) {
    info.key = this.key;
    this.signallingChannel.emit('message', JSON.stringify(info));
  }.bind(this)).fail(function(err) {
    console.error(err);
    return {
      "errcode": "FAILED",
      "message": "Error initializing connection: " + err
    };
  });
};

TCPTransport.prototype.onConnection = function(connInfo) {
  var remote = freedom['core.tcpsocket'](connInfo.socket);
  remote.on('onData', this.onData.bind(this, remote));
  remote.on('onDisconnect', this.onDisconnect.bind(this, remote));
};

TCPTranport.prototype.onSignallingMsg = function(msg) {
  var remoteInfo = JSON.parse(msg);
  this.remoteKey = remoteInfo.key;

  var conn = freedom['core.tcpsocket']();
  conn.on('onData', this.onData.bind(this, conn));
  conn.on('onDisconnect', this.onDisconnect.bind(this, conn));
  conn.connect(remoteInfo.localHost, remoteInfo.localPort).then(function() {
    this.conn = conn;
    var buffer = new Uint32Array(2);
    buffer[0] = this.key;
    buffer[1] = this.remoteKey;
    conn.write(buffer.buffer);
  }.bind(this));
};

TCPTransport.prototype.send = function(tag, data) {
  if (!this.conn) {
    return Promise.reject({
      "errcode": "NOTREADY",
      "message": "send called when in a non-connected state"
    });
  }

  var header = JSON.stringify({
    length: data.byteLength,
    tag: tag
  });
  
  // Build Header.
  var headerBuffer = new Uint8Array(header.length + 4);
  new DataView(headerBuffer.buffer).setUint32(0, header.length);
  for (var i = 0; i < header.length; i++) {
    headerBuffer[i + 4] = header.charCodeAt(i);
  }

  // Write header, data.
  return this.conn.write(headerBuffer).then(this.conn.write.bind(this, data));
};

TCPTransport.prototype.onData = function(conn, data) {
  var view = new DataView(data);
  if (this.state === 'negotiating') {
    var key = view.getInt32(0);
    var myKey = view.getInt32(1);
    if (myKey !== this.key) {
      return conn.close();
    }

    if (key < this.key || !this.conn) {
      this.conn = conn;
      this.state = 'clean';
    } else {
      conn.off();
      conn.close();
    }
  } else if (this.state === 'clean') {
    // First byte will be header length.
    var len = view.getUint32(0);
    if (data.byteLength < len + 4) {
      console.error(this.name, 'Dropping Message of length ' + data.byteLength,
        'Expecting new chunk, but invalid header found.');
      return;
    }
    var header = '';
    for (var i = 0; i < len; i++) {
      header += String.fromCharCode(view.getUInt8(i + 4));
    }
    header = JSON.parse(header);
    this.state = header;
    this.state.remaining = this.state.length;
    this.state.buffers = [];

    // Finally, some of the message data may be in the same raised event.
    if (data.byteLength > len + 4) {
      this.onData(conn, data.slice(len + 4));
    }
  } else {
    // Chunk finished.
    if (data.byteLength > this.state.remaining) {
      var boundary = this.state.remaining;
      this.onData(conn, data.slice(0, boundary));
      this.onData(conn, data.slice(boundary));
    } else if (data.byteLength == this.state.remaining) {
      if (this.state.buffers.length !== 0) {
        // Recombination finished.
        this.state.buffers.push(data);
        data = this.assemble(this.state.length, this.state.buffers);
      }
      this.dispatchEvent('onData', {
        "tag": this.state.tag,
        "data": data
      });
      this.state = 'clean';
    } else {
      this.state.buffers.push(data);
      this.state.remaining -= data.byteLength;
    }
  }
};

TCPTransport.prototype.onDisconnect = function(conn) {
  if (conn === this.conn) {
    this.dispatchEvent('onClose', null);
    this.conn = null;
  }
};

TCPTransport.prototype.close = function() {
  if (this.conn) {
    var promise = this.conn.close();
    this.conn = null;
    return promise;
  } else {
    return Promise.reject({
      "errcode": "",
      "message": "Could not closed non-active transport"
    });
  }
};

/**
 * Assemble an array of bufffers |buffers| of total length |length|
 * into a single array buffer.
 * @private
 * @method assemble
 * @param {Integer} length The byte length of the buffers
 * @param {ArrayBuffer[]} buffers The array of chunks comprising the buffer.
 * @returns {ArrayBuffer} A single buffer with the concatinated data.
 */
TCPTransport.prototype.assemble = function(length, buffers) {
  var buffer = new ArrayBuffer(length);
  var view = new Uint8Array(buffer);
  var position = 0;
  buffers.forEach(function(buffer) {
    view.set(new Uint8Array(buffer), position);
    position += buffer.byteLength;
  });
  return buffer;
};

/** Register Provider */
if (typeof freedom !== 'undefined') {
  freedom.transport().providePromises(TCPTransport);
}

