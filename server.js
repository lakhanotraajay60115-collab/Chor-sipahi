// server.js (સંપૂર્ણ નવો કોડ)

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 4;
const MAX_ROUNDS = 10;

// --- રૂમ લોજિક માટે મુખ્ય ઑબ્જેક્ટ ---
let rooms = {}; // રૂમ ID -> { players, currentRound, roles, chatHistory, roundActive, maxRounds, currentLanguage }

// રૂમ ID જનરેટ કરવા માટેનું સરળ ફંક્શન
function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// --- ગેમ લોજિક ફંક્શન્સ (હવે roomId સ્વીકારે છે) ---

function getRoomState(roomId) {
    return rooms[roomId];
}

function updateRoomPlayers(roomId, players) {
    if (rooms[roomId]) {
        rooms[roomId].players = players;
    }
}

function assignRoles(roomId) {
    const room = getRoomState(roomId);
    if (!room) return;

    let roles = ['રાજા', 'રાણી', 'વજીર', 'ચોર'];
    const playerCount = Object.keys(room.players).length;
    
    // ૪ થી વધુ ખેલાડીઓ માટે 'સિપાહી' ઉમેરો
    if (playerCount > 4) {
        const extraRoles = playerCount - 4;
        for (let i = 0; i < extraRoles; i++) {
            roles.push('સિપાહી');
        }
    }

    // રોલને શફલ કરો
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    let roleIndex = 0;
    const playerIds = Object.keys(room.players);
    let newPlayers = { ...room.players };

    playerIds.forEach(id => {
        newPlayers[id].currentRole = roles[roleIndex++];
        newPlayers[id].isVoted = false;
        newPlayers[id].roundMessage = ''; 
    });

    updateRoomPlayers(roomId, newPlayers);
    room.roundActive = true;
    
    // દરેક ખેલાડીને તેનો રોલ મોકલો
    playerIds.forEach(id => {
        io.to(id).emit('yourRole', newPlayers[id].currentRole);
    });
}


function checkVotes(roomId) {
    const room = getRoomState(roomId);
    if (!room || !room.roundActive) return;

    const totalPlayers = Object.keys(room.players).length;
    const votedPlayers = Object.values(room.players).filter(p => p.isVoted).length;

    if (votedPlayers >= totalPlayers - 1) { // ચોર સિવાયના બધાએ વોટ કર્યો
        endRound(roomId);
    }
}

function endRound(roomId) {
    const room = getRoomState(roomId);
    if (!room || !room.roundActive) return;

    room.roundActive = false;
    room.currentRound++;
    
    let thiefId = null;
    let thiefName = '';
    
    // રાઉન્ડના પરિણામોની ગણતરી કરો
    let newPlayers = { ...room.players };
    
    // રોલ આઈડેન્ટિફિકેશન
    Object.values(newPlayers).forEach(p => {
        if (p.currentRole === 'ચોર') {
            thiefId = p.id;
            thiefName = p.name;
        }
    });

    let voteCount = {};
    let thiefCaught = false;
    let thiefPointsGain = 0;

    // વોટની ગણતરી
    Object.keys(room.votes).forEach(voterId => {
        const votedId = room.votes[voterId];
        voteCount[votedId] = (voteCount[votedId] || 0) + 1;
    });

    // સૌથી વધુ વોટ મેળવનાર ખેલાડી
    const maxVotesPlayerId = Object.keys(voteCount).reduce((a, b) => (voteCount[a] > voteCount[b] ? a : b), null);
    
    // જો ચોર પકડાઈ ગયો હોય
    if (maxVotesPlayerId === thiefId) {
        thiefCaught = true;
    }

    // સ્કોર અપડેટ લોજિક
    Object.values(newPlayers).forEach(p => {
        const role = p.currentRole;
        let points = 0;
        let messageKey = '';

        if (thiefCaught) {
            // ચોર પકડાય તો બધા રોલ (ચોર સિવાય) ને પોઈન્ટ મળે
            if (role === 'રાજા') points = 50;
            else if (role === 'રાણી') points = 50;
            else if (role === 'વજીર') points = 50;
            else if (role === 'સિપાહી') points = 30; // સિપાહીને પણ પોઈન્ટ
            
            if (role === 'ચોર') {
                points = -20; // ચોરને નેગેટિવ પોઈન્ટ
                messageKey = 'ચોર પકડાયો: -૨૦';
            } else {
                messageKey = 'ચોર પકડાયો: + પોઈન્ટ';
            }

        } else {
            // ચોર છટકી જાય તો માત્ર ચોરને પોઈન્ટ મળે
            if (role === 'ચોર') {
                points = 100;
                thiefPointsGain = 100;
                messageKey = 'ચોર છટકી ગયો: +૧૦૦';
            } else {
                messageKey = 'ચોર છટકી ગયો: ૦';
            }
        }

        p.totalScore += points;
        p.roundMessage = messageKey;
    });

    // પરિણામ મોકલો
    const roundResult = {
        players: newPlayers,
        thiefCaught,
        thiefName,
        thiefPointsGain,
        nextRound: room.currentRound < room.maxRounds ? 'નવા રાઉન્ડ માટે તૈયાર થાઓ...' : 'આ છેલ્લો રાઉન્ડ હતો.',
        currentLanguage: room.currentLanguage
    };
    
    // વોટ અને પ્લેયર સ્ટેટ રીસેટ કરો
    room.votes = {};
    Object.values(newPlayers).forEach(p => p.isVoted = false);
    updateRoomPlayers(roomId, newPlayers);

    io.to(roomId).emit('roundResult', roundResult);

    // ગેમ સમાપ્ત કરો કે નવો રાઉન્ડ શરૂ કરો
    if (room.currentRound >= room.maxRounds) {
        setTimeout(() => endGame(roomId), 5000); 
    } else {
        setTimeout(() => startNewRound(roomId), 8000); 
    }
}

function startNewRound(roomId) {
    const room = getRoomState(roomId);
    if (!room) return;
    
    assignRoles(roomId);
    io.to(roomId).emit('newRound', { round: room.currentRound, maxRounds: room.maxRounds, currentLanguage: room.currentLanguage });
}

function endGame(roomId) {
    const room = getRoomState(roomId);
    if (!room) return;

    let finalScores = room.players;
    
    // વિજેતા શોધો
    const winner = Object.values(finalScores).sort((a, b) => b.totalScore - a.totalScore)[0];

    io.to(roomId).emit('gameEnd', { winner, finalScores, currentLanguage: room.currentLanguage });
    
    // રૂમ સાફ કરો
    delete rooms[roomId]; 
}


// --- Socket.IO કનેક્શન અને રૂમ મેનેજમેન્ટ ---

io.on('connection', (socket) => {
    console.log('નવો ખેલાડી જોડાયો:', socket.id);
    
    // રૂમ બનાવવાની વિનંતી
    socket.on('createRoom', (name) => {
        const roomId = generateRoomId();
        
        // નવો રૂમ ઓબ્જેક્ટ બનાવો
        rooms[roomId] = {
            players: {},
            currentRound: 0,
            votes: {},
            roundActive: false,
            maxRounds: MAX_ROUNDS,
            chatHistory: [],
            currentLanguage: 'gu' 
        };
        
        // ખેલાડીને રૂમમાં જોડો
        socket.join(roomId);
        socket.roomId = roomId;
        
        // ખેલાડી ડેટા
        rooms[roomId].players[socket.id] = {
            id: socket.id,
            name: name,
            currentRole: '',
            totalScore: 0,
            isHost: true, // બનાવનાર હંમેશા Host
            isVoted: false,
            roundMessage: ''
        };
        
        socket.emit('roomCreated', { roomId, currentLanguage: rooms[roomId].currentLanguage, isHost: true });
        io.to(roomId).emit('playerListUpdate', Object.values(rooms[roomId].players));
        console.log(`રૂમ ${roomId} બનાવવામાં આવ્યો. હોસ્ટ: ${name}`);
    });

    // રૂમમાં જોડાવાની વિનંતી
    socket.on('joinRoom', (data) => {
        const { roomId, name } = data;
        
        if (!rooms[roomId]) {
            return socket.emit('error', 'આ રૂમ ID અમાન્ય છે અથવા અસ્તિત્વમાં નથી.');
        }

        const room = rooms[roomId];

        if (Object.keys(room.players).length >= MAX_PLAYERS) {
            return socket.emit('error', 'રૂમ ભરાઈ ગયો છે.');
        }
        
        // ખેલાડીને રૂમમાં જોડો
        socket.join(roomId);
        socket.roomId = roomId;

        // ખેલાડી ડેટા
        room.players[socket.id] = {
            id: socket.id,
            name: name,
            currentRole: '',
            totalScore: 0,
            isHost: false,
            isVoted: false,
            roundMessage: ''
        };
        
        socket.emit('roomJoined', { roomId, currentLanguage: room.currentLanguage, isHost: false });
        
        // નવા જોડાનારને ચેટનો ઇતિહાસ મોકલો
        if (room.chatHistory.length > 0) {
            socket.emit('loadChatHistory', room.chatHistory); 
        }

        io.to(roomId).emit('playerListUpdate', Object.values(room.players));
        console.log(`ખેલાડી ${name} રૂમ ${roomId} માં જોડાયો.`);

        // જો ૪ ખેલાડીઓ પૂરા થાય તો ગેમ શરૂ કરો
        if (Object.keys(room.players).length === MIN_PLAYERS && !room.roundActive) {
            startNewRound(roomId);
        }
    });

    // ભાષા બદલવાની વિનંતી (માત્ર હોસ્ટ દ્વારા)
    socket.on('setLanguage', (lang) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        
        const room = rooms[socket.roomId];
        
        // ખાતરી કરો કે વિનંતી કરનાર હોસ્ટ છે
        if (room.players[socket.id] && room.players[socket.id].isHost) {
            room.currentLanguage = lang;
            io.to(socket.roomId).emit('languageChanged', lang);
        }
    });

    // વોટ સબમિટ કરવો
    socket.on('submitVote', (votedId) => {
        if (!socket.roomId || !rooms[socket.roomId] || !rooms[socket.roomId].players[socket.id] || !rooms[socket.roomId].roundActive) return;
        
        const room = rooms[socket.roomId];

        if (room.players[socket.id].currentRole === 'ચોર') {
            return; // ચોર વોટ કરી શકતો નથી
        }
        
        room.votes[socket.id] = votedId;
        room.players[socket.id].isVoted = true;
        
        // રૂમના બધા ખેલાડીઓને મોકલો કે વોટ આવી ગયો છે
        io.to(socket.roomId).emit('voteUpdate', { message: `${room.players[socket.id].name} એ વોટ કર્યો છે.` });

        checkVotes(socket.roomId);
    });

    // ચેટ મેસેજ
    socket.on('chatMessage', (msg) => {
        if (!socket.roomId || !rooms[socket.roomId] || !rooms[socket.roomId].players[socket.id]) return;

        const room = rooms[socket.roomId];
        const sender = room.players[socket.id].name;
        const messageObject = { name: sender, message: msg, timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) };
        
        room.chatHistory.push(messageObject); // મેસેજ હિસ્ટરીમાં સેવ કરો
        
        // માત્ર છેલ્લા 50 મેસેજ જ રાખો (મેમરી બચાવવા)
        if (room.chatHistory.length > 50) {
            room.chatHistory.shift(); 
        }
        
        io.to(socket.roomId).emit('chatMessage', messageObject); // રૂમના બધા ક્લાયન્ટને મોકલો
    });

    // ડિસ્કનેક્ટ
    socket.on('disconnect', () => {
        if (!socket.roomId || !rooms[socket.roomId]) return;

        const roomId = socket.roomId;
        const room = rooms[roomId];
        const playerName = room.players[socket.id] ? room.players[socket.id].name : 'અજ્ઞાત ખેલાડી';

        delete room.players[socket.id];
        
        console.log(`ખેલાડી ${playerName} (${socket.id}) રૂમ ${roomId} માંથી ડિસ્કનેક્ટ થયો.`);

        if (Object.keys(room.players).length === 0) {
            // જો રૂમમાં કોઈ ન હોય તો રૂમ સાફ કરો
            delete rooms[roomId];
            console.log(`રૂમ ${roomId} સાફ કરવામાં આવ્યો.`);
        } else {
            // જો હોસ્ટ ડિસ્કનેક્ટ થાય તો નવા હોસ્ટને એસાઇન કરો
            if (!Object.values(room.players).some(p => p.isHost)) {
                const firstPlayerId = Object.keys(room.players)[0];
                room.players[firstPlayerId].isHost = true;
                io.to(firstPlayerId).emit('setHost', true);
            }
            // બાકીના ખેલાડીઓને અપડેટ કરો
            io.to(roomId).emit('playerListUpdate', Object.values(room.players));
        }
    });
});

app.use(express.static('public'));

server.listen(PORT, () => {
    console.log(`સર્વર પોર્ટ ${PORT} પર ચાલી રહ્યું છે.`);
});
