const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { log } = require('console');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// ગેમ સ્ટેટ
let rooms = {};
let roomCounter = 1000;

// સ્થિર ફાઇલો માટે 'public' ફોલ્ડરનો ઉપયોગ કરો
app.use(express.static(path.join(__dirname, 'public')));

// હોમપેજ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ઉપયોગી ફંક્શન: રેન્ડમ રૂમ ID જનરેટ કરો
function generateRoomId() {
    let id;
    do {
        id = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[id]);
    return id;
}

// ઉપયોગી ફંક્શન: રેન્ડમ રોલ્સ સોંપો
function assignRoles(playerIds) {
    const roles = ['રાજા', 'રાણી', 'વજીર', 'ચોર'];
    
    // જો ૫ કે તેથી વધુ ખેલાડી હોય, તો સિપાહી ઉમેરો
    if (playerIds.length >= 5) {
        // બાકીના સ્લોટ સિપાહી માટે ભરો
        const requiredSipahi = playerIds.length - roles.length;
        for (let i = 0; i < requiredSipahi; i++) {
            roles.push('સિપાહી');
        }
    }
    
    // રોલ્સને શફલ કરો
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

// ઉપયોગી ફંક્શન: ગેમ પોઈન્ટ્સ અપડેટ કરો
function updateScores(room, thiefCaught) {
    const players = room.players;
    Object.values(players).forEach(p => {
        const role = p.currentRole;
        if (role === 'રાજા' && thiefCaught) p.totalScore += 100;
        if (role === 'રાણી' && thiefCaught) p.totalScore += 50;
        if (role === 'વજીર' && thiefCaught) p.totalScore += 75;
        if (role === 'સિપાહી' && thiefCaught) p.totalScore += 25;
        if (role === 'ચોર' && !thiefCaught) p.totalScore += 100;

        // રાઉન્ડ મેસેજ સેટ કરો
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

// મુખ્ય Socket.IO કનેક્શન લોજિક
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
            // ભાષા સેટિંગ
            currentLanguage: 'gu', 
            // ચેટ હિસ્ટરી
            chatHistory: []
        };
        
        socket.emit('roomCreated', { roomId: roomId, currentLanguage: 'gu', isHost: true });
        io.to(roomId).emit('playerListUpdate', Object.values(rooms[roomId].players));
    });

    socket.on('joinRoom', ({ roomId, name }) => {
        const room = rooms[roomId.toUpperCase()];
        if (!room) {
            return socket.emit('error', 'આ રૂમ ID અસ્તિત્વમાં નથી.');
        }
        if (Object.keys(room.players).length >= 8) {
             return socket.emit('error', 'રૂમ ભરેલો છે. (મહત્તમ ૮ ખેલાડીઓ)');
        }

        socket.roomId = room.id;
        socket.join(room.id);

        room.players[socket.id] = { id: socket.id, name, totalScore: 0, currentRole: null, isHost: false, roundMessage: '' };

        socket.emit('roomJoined', { roomId: room.id, currentLanguage: room.currentLanguage, isHost: false });
        socket.emit('loadChatHistory', room.chatHistory);
        io.to(room.id).emit('playerListUpdate', Object.values(room.players));
    });

    socket.on('setLanguage', (lang) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId) {
            room.currentLanguage = lang;
            // રૂમના બધા સભ્યોને જાણ કરો
            io.to(socket.roomId).emit('languageChanged', lang);
        }
    });
    
    // --- ગેમ મેનેજમેન્ટ ---
    
    // ગેમ શરૂ કરવા માટે ટાઈમર સેટ કરો
    const MIN_PLAYERS = 4;
    function startGameTimer(roomId) {
        const room = rooms[roomId];
        if (!room || room.gameStarted) return;
        
        if (Object.keys(room.players).length >= MIN_PLAYERS) {
            // અહીંથી રાઉન્ડ શરૂ કરો
            startNewRound(roomId);
        }
    }

    function startNewRound(roomId) {
        const room = rooms[roomId];
        if (!room || room.currentRound >= room.maxRounds) {
            return endGame(roomId);
        }

        room.gameStarted = true;
        room.currentRound++;
        
        const playerIds = Object.keys(room.players);
        const roles = assignRoles(playerIds);
        
        let thiefId = null;

        // ખેલાડીના રોલ્સ અપડેટ કરો અને તેમને મોકલો
        playerIds.forEach(id => {
            room.players[id].currentRole = roles[id];
            // ચોરને શોધો
            if (roles[id] === 'ચોર') {
                thiefId = id;
            }
            io.to(id).emit('yourRole', roles[id]);
        });
        
        room.thiefId = thiefId;
        room.votes = {}; // વોટ્સ રીસેટ કરો
        
        io.to(roomId).emit('newRound', {
            round: room.currentRound,
            maxRounds: room.maxRounds
        });
    }

    function endGame(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        let winner = null;
        let maxScore = -1;

        // વિજેતા શોધો
        Object.values(room.players).forEach(p => {
            if (p.totalScore > maxScore) {
                maxScore = p.totalScore;
                winner = p;
            } else if (p.totalScore === maxScore) {
                // ટાઈ હોય તો, છેલ્લા વિજેતાને રહેવા દો
            }
        });

        io.to(roomId).emit('gameEnd', {
            finalScores: room.players,
            winner: winner,
            currentLanguage: room.currentLanguage
        });

        // રૂમનો ડેટા સાફ કરો (ગેમ સમાપ્ત થયા પછી તરત જ રૂમ દૂર કરશો નહીં)
        room.gameStarted = false;
        room.currentRound = 0;
        Object.values(room.players).forEach(p => p.currentRole = null);
        // રૂમનો ડેટા સાફ કરવાની નીતિ અહીં લાગુ કરો.

        // જો રૂમમાં પ્લેયર્સ ન હોય તો 30 સેકન્ડ પછી રૂમ દૂર કરો
        if (Object.keys(room.players).length === 0) {
            delete rooms[roomId];
        }
    }
    
    // વોટ સબમિટ ઇવેન્ટ
    socket.on('submitVote', (votedPlayerId) => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted) return;

        const voter = room.players[socket.id];
        
        // જો રાજા/વજીર ન હોય કે ચોર ન હોય તો વોટ સ્વીકારો
        if (voter.currentRole !== 'ચોર') { 
            room.votes[socket.id] = votedPlayerId;
        }

        const playersCount = Object.keys(room.players).length;
        const votesCast = Object.keys(room.votes).length;

        // રૂમમાં ચોર સિવાયના ખેલાડીઓની સંખ્યા
        const nonThiefCount = playersCount - 1; 

        io.to(socket.roomId).emit('voteUpdate', {
            message: `${voter.name} એ વોટ કર્યો છે. (${votesCast}/${nonThiefCount} વોટ પડ્યા)`
        });

        if (votesCast >= nonThiefCount) {
            processVotes(socket.roomId);
        }
    });

    function processVotes(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const votedForThief = {}; // કયા ખેલાડીને વોટ મળ્યા તેની ગણતરી
        Object.values(room.votes).forEach(votedId => {
            votedForThief[votedId] = (votedForThief[votedId] || 0) + 1;
        });

        // સૌથી વધુ વોટ કોને મળ્યા
        let maxVotes = 0;
        let mostVotedPlayerId = null;

        for (const id in votedForThief) {
            if (votedForThief[id] > maxVotes) {
                maxVotes = votedForThief[id];
                mostVotedPlayerId = id;
            }
        }

        const thiefCaught = mostVotedPlayerId === room.thiefId;

        // સ્કોર અપડેટ કરો
        updateScores(room, thiefCaught);

        io.to(roomId).emit('roundResult', {
            thiefCaught,
            thiefName: room.players[room.thiefId].name,
            thiefPointsGain: 100, // ચોર ભાગી જાય તો 100 પોઈન્ટ મળે છે
            players: room.players,
            currentLanguage: room.currentLanguage
        });

        // નવા રાઉન્ડ માટે ટાઈમર સેટ કરો
        setTimeout(() => {
            if (room.gameStarted) {
                startNewRound(roomId);
            }
        }, 5000); // 5 સેકન્ડ પછી નવો રાઉન્ડ શરૂ કરો
    }

    // --- ચેટ અને વૉઇસ ચેટ સિગ્નલિંગ ---

    socket.on('chatMessage', (message) => {
        const room = rooms[socket.roomId];
        if (room) {
            const playerName = room.players[socket.id]?.name || 'અજાણ્યો ખેલાડી';
            const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const chatData = { name: playerName, message, timestamp };
            
            room.chatHistory.push(chatData);
            // ચેટ હિસ્ટરીની સાઈઝ જાળવો
            if (room.chatHistory.length > 50) {
                room.chatHistory.shift();
            }

            io.to(socket.roomId).emit('chatMessage', chatData);
        }
    });
    
    // --- WebRTC સિગ્નલિંગ ---
    
    // ક્લાયન્ટ વૉઇસ માટે તૈયાર છે (માઇક્રોફોન શરૂ થયો)
    socket.on('voiceReady', () => {
        const room = rooms[socket.roomId];
        if (room) {
            // રૂમના બધા સભ્યોને જાણ કરો કે આ યુઝર (socket.id) WebRTC માટે તૈયાર છે
            socket.to(socket.roomId).emit('userReadyForVoice', socket.id);
        }
    });
    
    // ક્લાયન્ટ વૉઇસ બંધ કરે છે
    socket.on('voiceStop', () => {
        const room = rooms[socket.roomId];
        if (room) {
            socket.to(socket.roomId).emit('userDisconnectedVoice', socket.id);
        }
    });

    // ક્લાયન્ટ દ્વારા મોકલેલ ICE Candidate (નેટવર્ક માહિતી)
    socket.on('iceCandidate', (data) => {
        // આ મેસેજ માત્ર લક્ષ્ય ક્લાયન્ટને મોકલો
        socket.to(data.toId).emit('iceCandidate', {
            candidate: data.candidate,
            fromId: socket.id
        });
    });

    // ક્લાયન્ટ દ્વારા મોકલેલ SDP Offer (કનેક્શન ઓફર)
    socket.on('offer', (data) => {
        // આ મેસેજ માત્ર લક્ષ્ય ક્લાયન્ટને મોકલો
        socket.to(data.toId).emit('offer', {
            offer: data.offer,
            fromId: socket.id
        });
    });

    // ક્લાયન્ટ દ્વારા મોકલેલ SDP Answer (ઓફરનો સ્વીકાર)
    socket.on('answer', (data) => {
        // આ મેસેજ માત્ર લક્ષ્ય ક્લાયન્ટને મોકલો
        socket.to(data.toId).emit('answer', {
            answer: data.answer,
            fromId: socket.id
        });
    });
    
    // --- ડિસ્કનેક્ટ મેનેજમેન્ટ ---

    socket.on('disconnecting', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        
        // WebRTC કનેક્શન બંધ કરવા માટે અન્ય યુઝર્સને જાણ કરો
        socket.to(socket.roomId).emit('userDisconnectedVoice', socket.id);

        delete room.players[socket.id];

        // જો ડિસ્કનેક્ટ થનાર હોસ્ટ હોય
        if (socket.id === room.hostId) {
            const remainingPlayers = Object.keys(room.players);
            if (remainingPlayers.length > 0) {
                // નવા હોસ્ટને સોંપો
                room.hostId = remainingPlayers[0];
                room.players[room.hostId].isHost = true;
                io.to(room.hostId).emit('setHost', true);
            }
        }
        
        io.to(socket.roomId).emit('playerListUpdate', Object.values(room.players));
        
        // જો ગેમ શરૂ થઈ ગઈ હોય અને ખેલાડીઓ MIN_PLAYERS કરતાં ઓછા થઈ જાય
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
