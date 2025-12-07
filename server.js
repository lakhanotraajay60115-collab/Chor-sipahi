// server.js - રાજા-રાણી-વજીર-ચોર ગેમ લોજિક (સિપાહી સપોર્ટ સાથે)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- ગેમ વેરિએબલ્સ ---
let players = {};
// રોલ્સમાં 'સિપાહી' ઉમેરાયો છે
let roles = ['રાજા', 'રાણી', 'વજીર', 'ચોર']; 
let roundActive = false;
let votes = {}; // { voterId: votedPlayerId }
let currentRound = 0;
let currentLanguage = 'gu'; // Default language

const MAX_ROUNDS = 10;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8; // મહત્તમ ખેલાડીઓ

const ROLE_POINTS = {
    'રાજા': 10,
    'રાણી': 5,
    'વજીર': 3,
    'ચોર': 0,
    'સિપાહી': 2 // સિપાહી માટે 2 પોઈન્ટ
};

// C. સ્ટેટિક ફાઇલોને સર્વ કરો
app.use(express.static('public'));

// --- ગેમ કાર્યો ---

function assignRoles() {
    const playerIds = Object.keys(players);
    const playerCount = playerIds.length;
    if (playerCount < MIN_PLAYERS) return; 

    // 1. મુખ્ય 4 રોલ લો
    let requiredRoles = ['રાજા', 'રાણી', 'વજીર', 'ચોર'];
    
    // 2. વધારાના ખેલાડીઓ માટે 'સિપાહી' રોલ ઉમેરો
    const sipahiCount = playerCount - 4;
    for (let i = 0; i < sipahiCount; i++) {
        requiredRoles.push('સિપાહી');
    }
    
    let shuffledRoles = requiredRoles.sort(() => 0.5 - Math.random());
    
    // દરેક ખેલાડીને ભૂમિકા અને પોઈન્ટ સોંપો
    playerIds.forEach((id, index) => {
        players[id].role = shuffledRoles[index];
        players[id].currentPoints = ROLE_POINTS[players[id].role]; 
        players[id].isThief = (players[id].role === 'ચોર');
        // ક્લાયન્ટને તેમની ભૂમિકા મોકલો
        io.to(id).emit('yourRole', players[id].role);
    });
    
    console.log(`રાઉન્ડ ${currentRound} માટે ભૂમિકાઓ સોંપવામાં આવી. કુલ ખેલાડીઓ: ${playerCount}`);
}

function startNewRound() {
    if (Object.keys(players).length < MIN_PLAYERS) return;
    if (currentRound >= MAX_ROUNDS) {
        endGame();
        return;
    }
    
    currentRound++;
    roundActive = true;
    votes = {};
    
    // ભૂમિકાઓ અસાઇન કરો
    assignRoles();
    
    // ક્લાયન્ટને રાઉન્ડ શરૂ થવાની સૂચના આપો
    io.emit('newRound', {
        round: currentRound,
        maxRounds: MAX_ROUNDS,
        status: `નવો રાઉન્ડ ${currentRound} શરૂ! ચોરને શોધો.`,
        currentLanguage: currentLanguage // ભાષા ક્લાયન્ટને મોકલો
    });

    // વોટિંગ માટે 60 સેકન્ડનો સમય આપો
    setTimeout(calculateRoundScore, 60000); 
    console.log(`રાઉન્ડ ${currentRound} શરૂ થયો.`);
}

function calculateRoundScore() {
    if (!roundActive) return;
    roundActive = false;

    const playerIds = Object.keys(players);
    const playerCount = playerIds.length;
    if (playerCount < MIN_PLAYERS) return; 

    const thiefId = playerIds.find(id => players[id].isThief);
    let thiefCaught = false;
    let incorrectVoters = []; 
    let thiefPointsGain = 0;

    // 1. વોટની ગણતરી કરો
    const voteCounts = {}; 
    Object.values(votes).forEach(votedId => {
        voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
    });

    // 2. ચોર પકડાયો કે નહીં તે નક્કી કરો
    const maxVotes = Math.max(...Object.values(voteCounts));
    // જો વોટ ન થયા હોય તો maxVotes -Infinity આવશે, તેને 0 ગણો
    const mostVotedId = Object.keys(voteCounts).find(id => voteCounts[id] === maxVotes) || null;

    if (mostVotedId === thiefId && maxVotes >= 2) { // ઓછામાં ઓછા 2 વોટ સાથે પકડાયો
        thiefCaught = true;
    }
    
    // 3. પોઈન્ટની ગણતરી કરો (મુખ્ય લોજિક)
    playerIds.forEach(id => {
        const votedFor = votes[id];
        
        // જો ખેલાડી ચોર હોય
        if (players[id].isThief) {
             players[id].roundMessage = `તમે ચોર છો.`;
             return; 
        }

        // અન્ય ખેલાડીઓ માટે (રાજા, રાણી, વજીર, સિપાહી)
        const currentPoints = players[id].currentPoints;
        const roleName = players[id].role; // સિપાહી પણ અહીં જ હેન્ડલ થશે
        
        if (votedFor === undefined) {
            // વોટ નથી કર્યો
            players[id].totalScore += 0;
            thiefPointsGain += currentPoints;
            players[id].roundMessage = `વોટ ન કરવા બદલ 0 પોઈન્ટ. (${currentPoints} ચોરને મળ્યા)`;
            incorrectVoters.push(id);
        } else if (thiefCaught) {
            // ચોર પકડાયો છે
            if (votedFor === thiefId) {
                // સાચો વોટ
                players[id].totalScore += currentPoints;
                players[id].roundMessage = `સાચો વોટ! (${currentPoints} પોઈન્ટ જાળવ્યા)`;
            } else {
                // ખોટો વોટ
                players[id].totalScore += 0;
                thiefPointsGain += currentPoints;
                players[id].roundMessage = `ખોટો વોટ! 0 પોઈન્ટ. (${currentPoints} ચોરને મળ્યા)`;
                incorrectVoters.push(id);
            }
        } else {
            // ચોર પકડાયો નથી
            // રોલ પોઈન્ટ જાળવી રાખો
            players[id].totalScore += currentPoints;
            players[id].roundMessage = `ચોર પકડાયો નથી, તેથી ${currentPoints} પોઈન્ટ જાળવ્યા.`;
        }
    });
    
    // 4. ચોરના પોઈન્ટ ઉમેરો (અંતિમ ગણતરી)
    const thiefPlayer = Object.values(players).find(p => p.isThief);
    if(thiefPlayer) {
        const thiefPlayerId = thiefPlayer.id;
        if (!thiefCaught) {
            // જો ચોર પકડાયો ન હોય, તો તેને તેના રોલ પોઈન્ટ (0) + ચોરી કરેલા પોઈન્ટ મળે
            players[thiefPlayerId].totalScore += thiefPointsGain;
            players[thiefPlayerId].roundMessage = `ચોર પકડાયો નથી! +${thiefPointsGain} ચોરી કરેલા પોઈન્ટ મળ્યા.`;
        } else {
             // જો ચોર પકડાઈ ગયો હોય
            players[thiefPlayerId].totalScore += 0;
            players[thiefPlayerId].roundMessage = `ચોર પકડાઈ ગયો! 0 પોઈન્ટ.`;
        }
    }
    
    // ક્લાયન્ટને પરિણામ મોકલો
    io.emit('roundResult', {
        players: players,
        thiefCaught: thiefCaught,
        thiefName: thiefPlayer ? thiefPlayer.name : 'N/A',
        thiefId: thiefId,
        thiefPointsGain: thiefPointsGain,
        nextRound: currentRound < MAX_ROUNDS ? `નવો રાઉન્ડ ${currentRound + 1} 10 સેકન્ડમાં શરૂ થશે.` : 'ગેમ સમાપ્ત!',
        currentLanguage: currentLanguage
    });

    console.log(`રાઉન્ડ ${currentRound} ના પોઈન્ટની ગણતરી પૂર્ણ થઈ. ચોર પકડાયો: ${thiefCaught}`);
    
    if (currentRound < MAX_ROUNDS) {
        setTimeout(startNewRound, 10000); 
    } else {
        setTimeout(endGame, 10000);
    }
}

function endGame() {
    // વિજેતા નક્કી કરો
    const winner = Object.values(players).reduce((prev, current) => 
        (prev.totalScore > current.totalScore) ? prev : current
    );

    io.emit('gameEnd', {
        winner: winner,
        finalScores: players,
        currentLanguage: currentLanguage
    });
    
    // રીસેટ
    players = {};
    currentRound = 0;
    votes = {};
    roundActive = false;
    currentLanguage = 'gu'; 
    console.log('ગેમ સમાપ્ત. વિજેતા:', winner.name);
}

// --- Socket.IO કનેક્શન લોજિક ---
io.on('connection', (socket) => {
    console.log('નવો ખેલાડી જોડાયો:', socket.id);
    
    // જો મહત્તમ ખેલાડીઓ જોડાઈ ગયા હોય, તો કનેક્શન કાપી નાખો
    if (Object.keys(players).length >= MAX_PLAYERS) {
        socket.emit('serverFull');
        socket.disconnect(true);
        console.log('સર્વર ફૂલ. કનેક્શન કાપ્યું.');
        return;
    }
    
    // પ્રારંભિક ડેટા સેટઅપ
    players[socket.id] = { 
        id: socket.id, 
        name: `ખેલાડી ${Object.keys(players).length + 1}`, 
        totalScore: 0,
        role: null,
        isThief: false,
        currentPoints: 0,
        roundMessage: '',
        isHost: Object.keys(players).length === 0 
    };
    
    // ક્લાયન્ટને તેની ID અને Host સ્થિતિ મોકલો
    socket.emit('yourId', socket.id); 
    socket.emit('setHost', players[socket.id].isHost);
    
    // પ્લેયર લિસ્ટ અપડેટ કરો
    io.emit('playerListUpdate', Object.values(players));
    
    // 1. નામ રજીસ્ટર કરો
    socket.on('registerName', (name) => {
        players[socket.id].name = name;
        io.emit('playerListUpdate', Object.values(players));
        
        // જો 4 ખેલાડીઓ જોડાઈ ગયા હોય અને ગેમ શરૂ ન થઈ હોય, તો ભાષા સેટ થયા પછી સ્ટાર્ટ કરો
        if (Object.keys(players).length >= MIN_PLAYERS && !roundActive && currentRound === 0) {
            console.log(`${MIN_PLAYERS} ખેલાડીઓ જોડાયા. ભાષા સેટિંગની રાહ છે.`);
        }
    });

    // 2. ભાષા બદલવાનું સંચાલન
    socket.on('setLanguage', (newLang) => {
        if (players[socket.id].isHost) {
            currentLanguage = newLang;
            io.emit('languageChanged', newLang);
            
            // જો પૂરતા ખેલાડીઓ જોડાયા હોય, તો રાઉન્ડ શરૂ કરો
             if (Object.keys(players).length >= MIN_PLAYERS && !roundActive && currentRound === 0) {
                 startNewRound();
             }
        }
    });
    
    // 3. વોટ સબમિટ કરો
    socket.on('submitVote', (votedPlayerId) => {
        if (!roundActive) return;
        
        votes[socket.id] = votedPlayerId;
        
        const totalVotes = Object.keys(votes).length;
        const totalPlayers = Object.keys(players).length;
        io.emit('voteUpdate', {
            voterId: socket.id,
            totalVotes: totalVotes,
            requiredVotes: totalPlayers,
            message: `${players[socket.id].name} એ વોટ કર્યો છે. (${totalVotes}/${totalPlayers})`
        });

        // જો બધાએ વોટ કરી દીધો હોય, તો સ્કોરની ગણતરી કરો
        if (totalVotes === totalPlayers) {
            calculateRoundScore();
        }
    });

    // 4. ચેટ મેસેજ હેન્ડલ કરો
    socket.on('chatMessage', (msg) => {
        const sender = players[socket.id].name;
        io.emit('chatMessage', { name: sender, message: msg });
    });
    
    // 5. ડિસકનેક્ટ
    socket.on('disconnect', () => {
        const wasHost = players[socket.id] ? players[socket.id].isHost : false;
        delete players[socket.id];
        console.log('ખેલાડી ડિસકનેક્ટ થયો:', socket.id);
        
        // જો Host ડિસકનેક્ટ થાય, તો નવા Host ને અસાઇન કરો
        if (wasHost && Object.keys(players).length > 0) {
            const newHostId = Object.keys(players)[0];
            players[newHostId].isHost = true;
            io.to(newHostId).emit('setHost', true);
            console.log('નવો Host અસાઇન થયો:', players[newHostId].name);
        }
        
        io.emit('playerListUpdate', Object.values(players));
        
        // જો રાઉન્ડ એક્ટિવ હોય અને ખેલાડીઓ MIN_PLAYERS થી ઓછા થઈ જાય, તો ગેમ બંધ કરો
        if (roundActive && Object.keys(players).length < MIN_PLAYERS) {
            io.emit('gameEnd', { message: 'ખેલાડીઓના અભાવે ગેમ સમાપ્ત થઈ.', currentLanguage: currentLanguage });
            players = {};
            currentRound = 0;
            votes = {};
            roundActive = false;
            currentLanguage = 'gu';
        }
    });
});

// F. સર્વરને પોર્ટ 3000 પર શરૂ કરો
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`સર્વર પોર્ટ ${PORT} પર ચાલુ છે. (http://localhost:${PORT})`);
});
