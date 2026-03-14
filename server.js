const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Increase max buffer size from default 1MB to 100MB for images
});

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function initDB() {
    try {
        await pool.query('CREATE DATABASE IF NOT EXISTS airtalk_db');
        await pool.query('USE airtalk_db');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                uuid VARCHAR(255) PRIMARY KEY,
                socket_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_uuid VARCHAR(255),
                friend_uuid VARCHAR(255),
                friend_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_friendship (user_uuid, friend_uuid)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS call_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_uuid VARCHAR(255),
                partner_uuid VARCHAR(255),
                partner_name VARCHAR(255),
                called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("MySQL Database initialized successfully.");
    } catch (e) {
        console.error("MySQL DB Initialization failed:", e.message);
    }
}
initDB();

app.use(express.static('public'));

let waitingUsers = [];
let activePairs = new Map(); // socket.id -> peerSocket.id

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Broadcast total connections to everyone
    io.emit('online-count', io.engine.clientsCount);

    socket.on('register', async (uuid) => {
        socket.userUUID = uuid;
        try {
            await pool.query('USE airtalk_db');
            await pool.query('INSERT IGNORE INTO users (uuid, socket_id) VALUES (?, ?)', [uuid, socket.id]);
            await pool.query('UPDATE users SET socket_id = ? WHERE uuid = ?', [socket.id, uuid]);
            
            // Fetch friends and history
            const [friends] = await pool.query('SELECT friend_uuid as id, friend_name as name FROM friends WHERE user_uuid = ?', [uuid]);
            const [history] = await pool.query('SELECT partner_uuid as id, partner_name as name, DATE_FORMAT(called_at, "%h:%i %p") as timestamp FROM call_history WHERE user_uuid = ? ORDER BY called_at DESC LIMIT 10', [uuid]);
            
            socket.emit('db-data', { friends, history });
        } catch(e) { console.error("Register Error", e.message); }
    });

    // User is ready to call
    socket.on('join-wait', async (userData) => {
        socket.userData = userData || { countryCode: 'un', countryName: 'Unknown', myGender: 'any', targetGender: 'any', targetCountry: 'any' };

        if (!waitingUsers.includes(socket.id) && !activePairs.has(socket.id)) {
            // Find a partner that mutual matches filters
            let foundIndex = -1;
            for (let i = 0; i < waitingUsers.length; i++) {
                const partnerId = waitingUsers[i];
                const partnerSocket = io.sockets.sockets.get(partnerId);
                if (!partnerSocket) continue;

                const A = socket.userData;
                const B = partnerSocket.userData;

                // Check Gender Match
                const genderMatch = 
                    (A.targetGender === 'any' || A.targetGender === B.myGender) &&
                    (B.targetGender === 'any' || B.targetGender === A.myGender);

                // Check Country Match
                const aCountryMatches = A.targetCountry === 'any' || (A.targetCountry === 'same' && A.countryCode === B.countryCode);
                const bCountryMatches = B.targetCountry === 'any' || (B.targetCountry === 'same' && B.countryCode === A.countryCode);
                const countryMatch = aCountryMatches && bCountryMatches;

                if (genderMatch && countryMatch) {
                    foundIndex = i;
                    break;
                }
            }

            if (foundIndex !== -1) {
                const partnerId = waitingUsers.splice(foundIndex, 1)[0];
                const partnerSocket = io.sockets.sockets.get(partnerId);
                const partnerData = partnerSocket ? partnerSocket.userData : { countryCode: 'un', countryName: 'Unknown' };
                
                activePairs.set(socket.id, partnerId);
                activePairs.set(partnerId, socket.id);

                // Notify both that they are matched
                io.to(socket.id).emit('matched', { role: 'caller', partnerId, partnerData, partnerUUID: partnerSocket.userUUID });
                io.to(partnerId).emit('matched', { role: 'callee', partnerId: socket.id, partnerData: socket.userData, partnerUUID: socket.userUUID });
                
                // Write to DB Call history
                try {
                    await pool.query('USE airtalk_db');
                    if(socket.userUUID && partnerSocket.userUUID) {
                        await pool.query('INSERT INTO call_history (user_uuid, partner_uuid, partner_name) VALUES (?, ?, ?)', [socket.userUUID, partnerSocket.userUUID, partnerData.countryName]);
                        await pool.query('INSERT INTO call_history (user_uuid, partner_uuid, partner_name) VALUES (?, ?, ?)', [partnerSocket.userUUID, socket.userUUID, socket.userData.countryName]);
                    }
                } catch(e) {}
                
                console.log(`Matched ${socket.id} with ${partnerId}`);
            } else {
                waitingUsers.push(socket.id);
                socket.emit('waiting');
                console.log(`User ${socket.id} is waiting (Filters active)`);
            }
        }
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) io.to(partnerId).emit('offer', data);
    });

    socket.on('answer', (data) => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) io.to(partnerId).emit('answer', data);
    });

    socket.on('ice-candidate', (data) => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) io.to(partnerId).emit('ice-candidate', data);
    });

    // End call manually
    socket.on('end-call', () => {
        endCall(socket.id);
    });

    // Friend request functionality
    socket.on('friend-request', () => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('friend-request');
        }
    });

    socket.on('accept-friend', async () => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('friend-accepted');
            
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket && socket.userUUID && partnerSocket.userUUID) {
                try {
                    await pool.query('USE airtalk_db');
                    await pool.query('INSERT IGNORE INTO friends (user_uuid, friend_uuid, friend_name) VALUES (?, ?, ?)', [socket.userUUID, partnerSocket.userUUID, partnerSocket.userData.countryName]);
                    await pool.query('INSERT IGNORE INTO friends (user_uuid, friend_uuid, friend_name) VALUES (?, ?, ?)', [partnerSocket.userUUID, socket.userUUID, socket.userData.countryName]);
                } catch (e) {
                     console.error("DB Friend error:", e.message);
                }
            }
        }
    });

    // Simple chat functionality
    socket.on('chat-message', (msg) => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('chat-message', msg);
        }
    });

    socket.on('chat-image', (imgData) => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('chat-image', imgData);
        }
    });

    socket.on('typing', () => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) io.to(partnerId).emit('typing');
    });

    socket.on('stop-typing', () => {
        const partnerId = activePairs.get(socket.id);
        if (partnerId) io.to(partnerId).emit('stop-typing');
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        endCall(socket.id);
        waitingUsers = waitingUsers.filter(id => id !== socket.id);
        
        // Broadcast new total connections
        io.emit('online-count', io.engine.clientsCount);
    });

    socket.on('request-direct-call', async (data) => {
        try {
            if (!socket.userData) socket.userData = { countryCode: 'un', countryName: 'Unknown Location', myGender: 'any', targetGender: 'any', targetCountry: 'any' };
            
            await pool.query('USE airtalk_db');
            const [rows] = await pool.query('SELECT socket_id FROM users WHERE uuid = ?', [data.targetUUID]);
            if (rows.length > 0) {
                const targetSocketId = rows[0].socket_id;
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                
                if (targetSocket && !activePairs.has(targetSocketId)) {
                    io.to(targetSocketId).emit('incoming-direct-call', { callerUUID: socket.userUUID, callerName: socket.userData.countryName });
                } else {
                    socket.emit('direct-call-declined');
                }
            } else {
                socket.emit('direct-call-declined'); 
            }
        } catch(e) { console.error('request call err', e.message); }
    });

    socket.on('accept-direct-call', async (data) => {
        try {
            if (!socket.userData) socket.userData = { countryCode: 'un', countryName: 'Unknown Location', myGender: 'any', targetGender: 'any', targetCountry: 'any' };
            
            await pool.query('USE airtalk_db');
            const [rows] = await pool.query('SELECT socket_id FROM users WHERE uuid = ?', [data.callerUUID]);
            if (rows.length > 0) {
                const callerSocketId = rows[0].socket_id;
                const callerSocket = io.sockets.sockets.get(callerSocketId);
                
                if (callerSocket && !activePairs.has(callerSocketId) && !activePairs.has(socket.id)) {
                    if (!callerSocket.userData) callerSocket.userData = { countryCode: 'un', countryName: 'Unknown Location', myGender: 'any', targetGender: 'any', targetCountry: 'any' };
                    
                    activePairs.set(socket.id, callerSocketId);
                    activePairs.set(callerSocketId, socket.id);
                    
                    const partnerData = callerSocket.userData;
                    const myData = socket.userData;
                    
                    // Remove both from waiting room explicitly
                    waitingUsers = waitingUsers.filter(id => id !== socket.id && id !== callerSocketId);

                    await pool.query('INSERT INTO call_history (user_uuid, partner_uuid, partner_name) VALUES (?, ?, ?)', [socket.userUUID, callerSocket.userUUID, partnerData.countryName]);
                    await pool.query('INSERT INTO call_history (user_uuid, partner_uuid, partner_name) VALUES (?, ?, ?)', [callerSocket.userUUID, socket.userUUID, myData.countryName]);

                    io.to(callerSocketId).emit('matched', { role: 'caller', partnerId: socket.id, partnerData: myData, partnerUUID: socket.userUUID });
                    io.to(socket.id).emit('matched', { role: 'callee', partnerId: callerSocketId, partnerData: partnerData, partnerUUID: callerSocket.userUUID });
                }
            }
        } catch(e) { console.error('accept call err', e.message); }
    });

    socket.on('decline-direct-call', async (data) => {
         try {
             await pool.query('USE airtalk_db');
             const [rows] = await pool.query('SELECT socket_id FROM users WHERE uuid = ?', [data.callerUUID]);
             if (rows.length > 0) {
                 io.to(rows[0].socket_id).emit('direct-call-declined', { reason: data.reason });
             }
         } catch(e) { console.error('decline call err', e.message); }
    });

    socket.on('check-status', async (uuids, callback) => {
        if (!uuids || !uuids.length) return callback({});
        const statuses = {};
        try {
             await pool.query('USE airtalk_db');
             const placeholders = uuids.map(() => '?').join(',');
             const [rows] = await pool.query(`SELECT uuid, socket_id FROM users WHERE uuid IN (${placeholders})`, uuids);
             rows.forEach(r => {
                 // Check if their socket_id is currently active
                 statuses[r.uuid] = io.sockets.sockets.has(r.socket_id);
             });
        } catch(e) {}
        if (typeof callback === 'function') callback(statuses);
    });

    function endCall(userId) {
        const partnerId = activePairs.get(userId);
        if (partnerId) {
            io.to(partnerId).emit('partner-disconnected');
            activePairs.delete(partnerId);
            activePairs.delete(userId);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
