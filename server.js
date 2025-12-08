// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Render પર PORT એન્વાયર્નમેન્ટ વેરીએબલનો ઉપયોગ કરો
const PORT = process.env.PORT || 3000;

// ગેમ સ્ટેટ
let rooms = {};

// સ્થિર ફાઇલો માટે 'public' ફોલ્ડરનો ઉપયોગ કરો
app.use(express.static(path.join(__dirname, 'public')));

// હોમપેજ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- ઉપયોગી ફંક્શન્સ ---

function generateRoomId() {
    let id;
    do {
        // 4 અક્ષરનો રેન્ડમ ID
        id = Math.random().toString(36).substring(2, 6).toUpperCase(); 
    } while (rooms[id]);
    return id;
}

function assignRoles(playerIds) {
    const roles = ['રાજા', 'રાણી', 'વજીર', 'ચોર'];
    
    if (playerIds.length >= 5) {
        const requiredSipahi = playerIds.length - roles.length;
        for (let i = 0; i < requiredSipahi; i++) {
            roles.push('સિપાહી');
        }
    }
    
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    const assignedRoles = {};
    playerIds.forEach((id, index) => {
        assignedRoles[id] = roles[index];
    });
    return assignedRoles;
}

function updateScores(room, thiefCaught) {
    const players = room.players;
    Object.values(players).forEach(p => {
        const role = p.currentRole;
        if (role === 'રાજા' && thiefCaught) p.totalScore += 100;
        if (role === 'રાણી' && thiefCaught) p.totalScore += 50;
        if (role === 'વજીર' && thiefCaught) p.totalScore += 75;
        if (role === 'સિપાહી' && thiefCaught) p.totalScore += 25;
        if (role === 'ચોર' && !thiefCaught) p.totalScore += 100;

        if (role === 'ચોર') {
            p.roundMessage = thiefCaught ? 'ચોર પકડાયો' : 'ચોર ભાગી ગયો';
        } else if (role === 'રાજા') {
            p.roundMessage = thiefCaught ? 'ચોરને પકડવામાં મદદ કરી' : 'ચોર ભાગી ગયો';
        } else if (role === 'વજીર') {
            p.roundMessage = thiefCaught ? 'સાચો નિર્ણય લીધો' : 'ખોટો નિર્ણય લીધો';
        } else {
            p.roundMessage = 'વોટ કર્યો';
        }
    });
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let winner = null;
    let maxScore = -1;

    Object.values(room.players).forEach(p => {
        if (p.totalScore > maxScore) {
            maxScore = p.totalScore;
            winner = p;
        } else if (p.totalScore === maxScore) {
            // ટાઈ
        }
    });

    io.to(roomId).emit('gameEnd', {
        finalScores: room.players,
        winner: winner,
        currentLanguage: room.currentLanguage
    });

    room.gameStarted = false;
    room.currentRound = 0;
    Object.values(room.players).forEach(p => p.currentRole = null);
    
    // જો રૂમમાં કોઈ ન હોય તો રૂમનો ડેટા સાફ કરો
    if (Object.keys(room.players).length === 0) {
        delete rooms[roomId];
    }
}

function startNewRound(roomId) {
    const room = rooms[roomId];
    const MIN_PLAYERS = 4;
    
    if (!room || Object.keys(room.players).length < MIN_PLAYERS) {
        if(room) room.gameStarted = false;
        return io.to(roomId).emit('error', 'ગેમ ચાલુ રાખવા માટે પૂરતા ખેલાડીઓ નથી.');
    }
    
    if (room.currentRound >= room.maxRounds) {
        return endGame(roomId);
    }

    room.gameStarted = true;
    room.currentRound++;
    
    const playerIds = Object.keys(room.players);
    const roles = assignRoles(playerIds);
    
    let thiefId = null;

    playerIds.forEach(id => {
        room.players[id].currentRole = roles[id];
        if (roles[id] === 'ચોર') {
            thiefId = id;
        }
        io.to(id).emit('yourRole', roles[id]);
    });
    
    room.thiefId = thiefId;
    room.votes = {};
    
    io.to(roomId).emit('newRound', {
        round: room.currentRound,
        maxRounds: room.maxRounds
    });
}

function processVotes(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const votedForThief = {}; 
    Object.values(room.votes).forEach(votedId => {
        votedForThief[votedId] = (votedForThief[votedId] || 0) + 1;
    });

    let maxVotes = 0;
    let mostVotedPlayerId = null;

    for (const id in votedForThief) {
        if (votedForThief[id] > maxVotes) {
            maxVotes = votedForThief[id];
            mostVotedPlayerId = id;
        }
    }

    const thiefCaught = mostVotedPlayerId === room.thiefId;

    updateScores(room, thiefCaught);

    io.to(roomId).emit('roundResult', {
        thiefCaught,
        thiefName: room.players[room.thiefId].name,
        thiefPointsGain: 100,
        players: room.players,
        currentLanguage: room.currentLanguage
    });

    setTimeout(() => {
        if (room.gameStarted) {
            startNewRound(roomId);
        }
    }, 5000); 
}

// --- મુખ્ય Socket.IO કનેક્શન લોજિક ---

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // --- રૂમ અને પ્લેયર મેનેજમેન્ટ ---

    socket.on('createRoom', (name) => {
        const roomId = generateRoomId();
        socket.roomId = roomId;
        socket.join(roomId);

        rooms[roomId] = {
            id: roomId,
            players: {
                [socket.id]: { id: socket.id, name, totalScore: 0, currentRole: null, isHost: true, roundMessage: '' }
            },
            hostId: socket.id,
            currentRound: 0,
            maxRounds: 10,
            gameStarted: false,
            currentLanguage: 'gu', 
            chatHistory: []
        };
        
        console.log(`Room created: ${roomId} by ${name} (${socket.id})`);
        
        socket.emit('roomCreated', { roomId: roomId, currentLanguage: 'gu', isHost: true });
        io.to(roomId).emit('playerListUpdate', Object.values(rooms[roomId].players));
    });

    socket.on('joinRoom', ({ roomId, name }) => {
        const upperRoomId = roomId.toUpperCase();
        const room = rooms[upperRoomId];
        
        if (!room) {
            return socket.emit('error', 'આ રૂમ ID અસ્તિત્વમાં નથી.');
        }
        if (Object.keys(room.players).length >= 8) {
             return socket.emit('error', 'રૂમ ભરેલો છે. (મહત્તમ ૮ ખેલાડીઓ)');
        }
        
        // જો ગેમ ચાલુ હોય તો જોડાવા ન દો
        if (room.gameStarted) {
             return socket.emit('error', 'ગેમ પહેલેથી જ ચાલુ છે. સમાપ્ત થાય તેની રાહ જુઓ.');
        }

        socket.roomId = room.id;
        socket.join(room.id);

        room.players[socket.id] = { id: socket.id, name, totalScore: 0, currentRole: null, isHost: false, roundMessage: '' };
        
        console.log(`User joined: ${name} (${socket.id}) to Room ${room.id}`);

        socket.emit('roomJoined', { roomId: room.id, currentLanguage: room.currentLanguage, isHost: false });
        socket.emit('loadChatHistory', room.chatHistory);
        io.to(room.id).emit('playerListUpdate', Object.values(room.players));
    });

    socket.on('setLanguage', (lang) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId) {
            room.currentLanguage = lang;
            io.to(socket.roomId).emit('languageChanged', lang);
        }
    });
    
    // હોસ્ટ દ્વારા ગેમ શરૂ કરવાની વિનંતી
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        const MIN_PLAYERS = 4;
        
        if (!room || socket.id !== room.hostId || room.gameStarted) return;
        
        if (Object.keys(room.players).length < MIN_PLAYERS) {
            return socket.emit('error', `ગેમ શરૂ કરવા માટે ઓછામાં ઓછા ${MIN_PLAYERS} ખેલાડીઓ જોઈએ.`);
        }
        
        startNewRound(socket.roomId);
    });

    socket.on('submitVote', (votedPlayerId) => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted) return;

        const voter = room.players[socket.id];
        
        // ચોર સિવાયના ખેલાડીઓને જ વોટ કરવાની છૂટ છે
        if (voter.currentRole !== 'ચોર') { 
            room.votes[socket.id] = votedPlayerId;
        }

        const playersCount = Object.keys(room.players).length;
        const votesCast = Object.keys(room.votes).length;
        
        // ચોર સિવાયના વોટર્સની ગણતરી
        const nonThiefCount = playersCount - 1; 

        io.to(socket.roomId).emit('voteUpdate', {
            message: `${voter.name} એ વોટ કર્યો છે. (${votesCast}/${nonThiefCount} વોટ પડ્યા)`
        });

        if (votesCast >= nonThiefCount) {
            processVotes(socket.roomId);
        }
    });
    
    // --- ચેટ અને WebRTC સિગ્નલિંગ ---

    socket.on('chatMessage', (message) => {
        const room = rooms[socket.roomId];
        if (room) {
            const playerName = room.players[socket.id]?.name || 'અજાણ્યો ખેલાડી';
            const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const chatData = { name: playerName, message, timestamp };
            
            room.chatHistory.push(chatData);
            if (room.chatHistory.length > 50) {
                room.chatHistory.shift();
            }

            io.to(socket.roomId).emit('chatMessage', chatData);
        }
    });
    
    // WebRTC સિગ્નલિંગ (વૉઇસ ચેટ)
    
    socket.on('voiceReady', () => {
        const room = rooms[socket.roomId];
        if (room) {
            socket.to(socket.roomId).emit('userReadyForVoice', socket.id);
        }
    });
    
    socket.on('voiceStop', () => {
        const room = rooms[socket.roomId];
        if (room) {
            socket.to(socket.roomId).emit('userDisconnectedVoice', socket.id);
        }
    });

    socket.on('iceCandidate', (data) => {
        socket.to(data.toId).emit('iceCandidate', {
            candidate: data.candidate,
            fromId: socket.id
        });
    });

    socket.on('offer', (data) => {
        socket.to(data.toId).emit('offer', {
            offer: data.offer,
            fromId: socket.id
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.toId).emit('answer', {
            answer: data.answer,
            fromId: socket.id
        });
    });
    
    // --- ડિસ્કનેક્ટ મેનેજમેન્ટ ---

    socket.on('disconnecting', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        
        socket.to(socket.roomId).emit('userDisconnectedVoice', socket.id);

        delete room.players[socket.id];

        if (socket.id === room.hostId) {
            const remainingPlayers = Object.keys(room.players);
            if (remainingPlayers.length > 0) {
                room.hostId = remainingPlayers[0];
                room.players[room.hostId].isHost = true;
                io.to(room.hostId).emit('setHost', true);
            }
        }
        
        io.to(socket.roomId).emit('playerListUpdate', Object.values(room.players));
        
        const MIN_PLAYERS = 4;
        if (room.gameStarted && Object.keys(room.players).length < MIN_PLAYERS) {
            room.gameStarted = false;
            io.to(socket.roomId).emit('error', 'ખેલાડીઓની સંખ્યા ઓછી થવાને કારણે ગેમ બંધ કરવામાં આવી છે.');
            endGame(socket.roomId);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
