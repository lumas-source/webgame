// server.js - COMPLETE FIXED VERSION FOR HTTPS/HTTP
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Determine environment
const isProduction = process.env.NODE_ENV === 'production';
const serverIP = '167.71.48.61'; // Your droplet IP

// Configure CORS properly for both development and production
const allowedOrigins = [
  `http://${serverIP}:3000`,
  `http://${serverIP}`,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8080'
];

// Socket.IO configuration with proper CORS
const io = socketIo(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

// CORS middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Session middleware with proper secure settings
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to false for HTTP, will be true when you setup HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Route handlers
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running', 
    timestamp: new Date().toISOString(),
    protocol: req.protocol
  });
});

// Game management - Only one game that runs continuously
const activeGames = {};
const pendingInvitations = {};
const userSessions = {};

// Global stores for admin functionality
global.depositRequests = [];
global.withdrawalRequests = [];
global.gameWinners = [];
global.gameHistory = [];

// Bank account information
const bankAccounts = {
  telebirr: {
    name: "Kasim Ebrahim / ቃሲም ኢብራሂም",
    number: "0996271241",
    type: "Telebirr"
  },
  cbe: {
    name: "Bingo Bonanza Account",
    number: "1000234567890",
    type: "CBE"
  },
  abyssinia: {
    name: "Bingo Bonanza Games",
    number: "2000345678901",
    type: "Abyssinia Bank"
  },
  other: {
    name: "Contact Support",
    number: "0911223344",
    type: "Other Bank"
  }
};

// Admin authentication middleware
function requireAdminAuth(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  } else {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
}

// Function to validate user session
function validateSession(sessionId, username) {
  if (!sessionId || !username) return false;

  const session = userSessions[sessionId];
  if (!session) return false;

  if (session.username !== username) return false;

  // Check if session is expired (24 hours)
  const lastActivity = new Date(session.lastActivity);
  const now = new Date();
  const hoursDiff = (now - lastActivity) / (1000 * 60 * 60);

  if (hoursDiff > 24) {
    delete userSessions[sessionId];
    return false;
  }

  // Update last activity
  session.lastActivity = now.toISOString();
  return true;
}

// Function to sanitize game object before sending to clients
function sanitizeGameObject(game) {
  const cleanGame = {
    id: game.id,
    entryFee: game.entryFee,
    gameType: game.gameType,
    creator: game.creator,
    invitedPlayers: game.invitedPlayers,
    players: {},
    currentNumber: game.currentNumber,
    calledNumbers: game.calledNumbers,
    gameStatus: game.gameStatus,
    prizePool: game.prizePool,
    maxPlayers: game.maxPlayers,
    minPlayers: game.minPlayers,
    timeRemaining: game.timeRemaining
  };

  // Clean players object
  for (const socketId in game.players) {
    const player = game.players[socketId];
    cleanGame.players[socketId] = {
      username: player.username,
      balance: player.balance,
      hasBingo: player.hasBingo,
      ready: player.ready,
      phone: player.phone,
      cardType: player.cardType
    };
  }

  return cleanGame;
}

// Function to create the single continuous game
function createContinuousGame() {
  const gameId = 1; // Only one game with ID 1

  // Clear any existing game
  if (activeGames[gameId]) {
    if (activeGames[gameId].cardSelectionInterval) {
      clearInterval(activeGames[gameId].cardSelectionInterval);
    }
    if (activeGames[gameId].numberCallingInterval) {
      clearInterval(activeGames[gameId].numberCallingInterval);
    }
  }

  const game = {
    id: gameId,
    entryFee: 10, // Default entry fee for the continuous game
    gameType: 'public',
    creator: 'system',
    invitedPlayers: [],
    players: {},
    currentNumber: null,
    calledNumbers: [],
    gameStatus: 'lobby',
    prizePool: 0,
    maxPlayers: 50,
    minPlayers: 1, // Game runs even with 1 player
    timeRemaining: 20,
    cardSelectionInterval: null,
    numberCallingInterval: null,
    isContinuous: true // Flag for continuous play
  };

  activeGames[gameId] = game;

  // Start the game cycle with card selection
  startCardSelectionCountdown(game);

  return game;
}

// Function to start card selection countdown for the game
function startCardSelectionCountdown(game) {
  if (game.cardSelectionInterval) {
    clearInterval(game.cardSelectionInterval);
  }

  game.timeRemaining = 20;
  game.gameStatus = 'lobby';

  game.cardSelectionInterval = setInterval(() => {
    if (game.gameStatus !== 'lobby') {
      clearInterval(game.cardSelectionInterval);
      return;
    }

    game.timeRemaining = Math.max(0, game.timeRemaining - 1);

    // Broadcast time update to all clients in this game
    io.to(game.id).emit('card-selection-time-update', {
      timeRemaining: game.timeRemaining
    });

    // If time runs out, automatically start the game
    if (game.timeRemaining <= 0) {
      clearInterval(game.cardSelectionInterval);
      startGame(game);
    }
  }, 1000);
}

// Function to start the game (number calling phase)
function startGame(game) {
  game.gameStatus = 'playing';

  // Deduct entry fee from all players who haven't paid yet
  const users = loadUsers();
  for (const socketId in game.players) {
    const player = game.players[socketId];
    if (users[player.username] && !player.feeDeducted) {
      users[player.username].balance -= game.entryFee;
      player.balance = users[player.username].balance;
      player.feeDeducted = true;
    }
  }
  saveUsers(users);

  // Update prize pool
  game.prizePool = Object.keys(game.players).length * game.entryFee;

  // Notify players that the game has started
  io.to(game.id).emit('game-started');

  // Start calling numbers
  startNumberCalling(game);

  // Broadcast game status update to all clients
  io.emit('player-count-update', {
    gameId: game.id,
    playerCount: Object.keys(game.players).length,
    gameStatus: game.gameStatus,
    timeRemaining: 0,
    calledNumbers: game.calledNumbers,
    currentNumber: game.currentNumber
  });
}

// Function to find user by phone number
function findUserByPhone(phone) {
  const users = loadUsers();
  for (const username in users) {
    if (users[username].phone === phone) {
      return { username, ...users[username] };
    }
  }
  return null;
}

// Simple user storage
const usersFile = 'users.json';

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(usersFile)) {
      const data = fs.readFileSync(usersFile, 'utf8');
      if (!data || data.trim() === '') {
        return {};
      }
      return JSON.parse(data);
    }
    return {};
  } catch (error) {
    console.error('Error loading users:', error);
    return {};
  }
}

// Save users to file
function saveUsers(users) {
  try {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

// Function to validate bingo claims
function validateBingo(playerCard, calledNumbers) {
  if (!playerCard || !Array.isArray(playerCard) || playerCard.length === 0) {
    console.error('Invalid player card:', playerCard);
    return false;
  }

  if (!calledNumbers || !Array.isArray(calledNumbers)) {
    console.error('Invalid called numbers:', calledNumbers);
    return false;
  }

  // Convert player card to a flat array for easier pattern checking
  let flatCard = [];
  try {
    // Player card is structured as columns, so we need to convert it to rows
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        // Handle free space in the center
        if (row === 2 && col === 2) {
          flatCard.push('FREE');
        } else {
          // Make sure the column exists and has the row
          if (playerCard[col] && playerCard[col][row] !== undefined) {
            flatCard.push(playerCard[col][row]);
          } else {
            console.error('Invalid card structure at col', col, 'row', row);
            return false;
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing player card:', error);
    return false;
  }

  const patterns = [
    // Rows
    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
    // Columns
    [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22],
    [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
    // Diagonals
    [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]
  ];

  for (const pattern of patterns) {
    let isBingo = true;
    for (const index of pattern) {
      // Skip center (free space)
      if (index === 12) continue;

      const number = flatCard[index];

      // Check if the number is valid and has been called
      if (number === undefined || number === null || number === 'FREE') {
        // Free space is always considered marked
        continue;
      }

      if (!calledNumbers.includes(number)) {
        isBingo = false;
        break;
      }
    }

    if (isBingo) return true;
  }

  return false;
}

// Function to determine winners
function determineWinners(game) {
  const winners = [];

  // Check all players for valid bingo
  for (const socketId in game.players) {
    const player = game.players[socketId];
    if (validateBingo(player.card, game.calledNumbers)) {
      winners.push({
        socketId: socketId,
        username: player.username
      });

      // Limit to 2 winners maximum
      if (winners.length >= 2) {
        break;
      }
    }
  }

  return winners;
}

// Function to distribute prizes
function distributePrizes(game, winners) {
  const houseCut = Math.floor(game.prizePool * 0.2);
  const prizePool = game.prizePool - houseCut;
  const prizePerWinner = Math.floor(prizePool / winners.length);

  const users = loadUsers();

  winners.forEach(winner => {
    if (users[winner.username]) {
      users[winner.username].balance += prizePerWinner;
      game.players[winner.socketId].balance += prizePerWinner;

      // Record the winner
      global.gameWinners.push({
        id: `win_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: winner.username,
        amount: prizePerWinner,
        gameId: game.id,
        date: new Date().toLocaleDateString(),
        status: 'pending'
      });
    }
  });

  saveUsers(users);

  return {
    houseCut: houseCut,
    prizePerWinner: prizePerWinner
  };
}

// Function to handle player disconnections properly
function handlePlayerDisconnect(socketId) {
  for (const gameId in activeGames) {
    const game = activeGames[gameId];
    if (game.players[socketId]) {
      const username = game.players[socketId].username;
      const feeDeducted = game.players[socketId].feeDeducted;

      // If game hasn't started yet, refund entry fee
      if (game.gameStatus === 'lobby' && feeDeducted) {
        const users = loadUsers();
        if (users[username]) {
          users[username].balance += game.entryFee;
          saveUsers(users);
        }
      }

      // If game is in progress, keep the fee in the prize pool
      // but remove the player from the game
      delete game.players[socketId];

      // Update prize pool (don't reduce it when players leave during gameplay)
      if (game.gameStatus === 'playing') {
        // Prize pool remains the same - fees are not refunded during gameplay
        console.log(`${username} left game ${gameId} during gameplay. Fee remains in prize pool.`);
      } else {
        // For lobby, reduce prize pool
        game.prizePool = Object.keys(game.players).length * game.entryFee;
      }

      // Broadcast updated game state to remaining players
      io.to(gameId).emit('game-state-update', sanitizeGameObject(game));

      // Broadcast player count update to all clients
      io.emit('player-count-update', {
        gameId: gameId,
        playerCount: Object.keys(game.players).length,
        gameStatus: game.gameStatus,
        timeRemaining: game.timeRemaining,
        calledNumbers: game.calledNumbers,
        currentNumber: game.currentNumber
      });

      console.log(`${username} left game ${gameId}. Remaining players: ${Object.keys(game.players).length}`);

      break;
    }
  }
}

// Function to start calling numbers for the game
function startNumberCalling(game) {
  console.log(`Starting to call numbers for game ${game.id}...`);
  game.calledNumbers = [];

  let callIndex = 0;
  const allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);

  // Shuffle the numbers
  for (let i = allNumbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allNumbers[i], allNumbers[j]] = [allNumbers[j], allNumbers[i]];
  }

  game.numberCallingInterval = setInterval(() => {
    // Stop if game is finished
    if (game.gameStatus !== 'playing') {
      clearInterval(game.numberCallingInterval);
      return;
    }

    // Stop if all numbers are called
    if (callIndex >= allNumbers.length) {
      clearInterval(game.numberCallingInterval);
      game.gameStatus = 'finished';

      // Determine winners
      const winners = determineWinners(game);

      if (winners.length > 0) {
        // Distribute prizes
        const prizeInfo = distributePrizes(game, winners);

        // Announce winners
        io.to(game.id).emit('winners-announced', {
          winners: winners,
          prizePool: game.prizePool,
          houseCut: prizeInfo.houseCut,
          prizePerWinner: prizeInfo.prizePerWinner
        });
      } else {
        io.to(game.id).emit('no-winners', {
          message: 'No winners this round! Prize pool rolls over to next game.'
        });
      }

      // Reset the game after a brief delay for continuous play
      setTimeout(() => {
        resetGame(game);
      }, 5000); // 5 second delay before next card selection
      return;
    }

    // Get the next number
    const newNum = allNumbers[callIndex];

    // Update game state
    game.currentNumber = newNum;
    game.calledNumbers.push(newNum);
    callIndex++;

    // Broadcast the new number to players in THIS game only
    io.to(game.id).emit('number-called', {
      number: newNum,
      allNumbers: game.calledNumbers,
      callIndex: callIndex
    });

    // Broadcast update to all clients for lobby display
    io.emit('player-count-update', {
      gameId: game.id,
      playerCount: Object.keys(game.players).length,
      gameStatus: game.gameStatus,
      timeRemaining: 0,
      calledNumbers: game.calledNumbers,
      currentNumber: game.currentNumber
    });

    console.log(`Called number ${newNum} in game ${game.id} (${callIndex}/75)`);

  }, 3000); // 3 seconds between numbers
}

// Function to reset the game for continuous play
function resetGame(game) {
  console.log(`Resetting game ${game.id} for continuous play...`);

  // Clear any intervals
  if (game.cardSelectionInterval) clearInterval(game.cardSelectionInterval);
  if (game.numberCallingInterval) clearInterval(game.numberCallingInterval);

  // Reset game state but keep players
  game.currentNumber = null;
  game.calledNumbers = [];
  game.gameStatus = 'lobby';
  game.prizePool = Object.keys(game.players).length * game.entryFee;
  game.timeRemaining = 20;

  // Reset player states but keep them in the game
  Object.keys(game.players).forEach(socketId => {
    game.players[socketId].card = [];
    game.players[socketId].hasBingo = false;
    game.players[socketId].ready = false;
    game.players[socketId].cardType = null;
    game.players[socketId].feeDeducted = false; // Reset fee deduction for new round
  });

  // Start a new card selection countdown
  startCardSelectionCountdown(game);

  // Broadcast the reset
  io.to(game.id).emit('game-reset');
  io.to(game.id).emit('game-state-update', sanitizeGameObject(game));

  console.log(`Game ${game.id} reset complete. Ready for new round.`);
}

// Function to broadcast balance updates to all connected clients
function broadcastBalanceUpdate(username, newBalance) {
  io.emit('balance-update', {
    username: username,
    balance: newBalance
  });
}

// API Routes

// Get user info
app.post('/api/user-info', (req, res) => {
  try {
    const { sessionId, username } = req.body;

    // Validate session
    if (!validateSession(sessionId, username)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const users = loadUsers();
    const user = users[username];

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      balance: user.balance,
      username: username,
      phone: user.phone
    });
  } catch (error) {
    console.error('Error in /api/user-info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available games - Only returns the single continuous game
app.get('/api/games', (req, res) => {
  try {
    const publicGames = [];

    for (const gameId in activeGames) {
      const game = activeGames[gameId];
      if (game.gameType === 'public') {
        publicGames.push({
          id: game.id,
          entryFee: game.entryFee,
          gameType: game.gameType,
          playerCount: Object.keys(game.players).length,
          prizePool: game.prizePool,
          maxPlayers: game.maxPlayers,
          gameStatus: game.gameStatus,
          timeRemaining: game.timeRemaining,
          calledNumbers: game.calledNumbers,
          currentNumber: game.currentNumber
        });
      }
    }

    res.json(publicGames);
  } catch (error) {
    console.error('Error in /api/games:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new game - Only allows joining the existing continuous game
app.post('/api/create-game', (req, res) => {
  try {
    const { entryFee, gameType, invitedPlayers, creator, sessionId } = req.body;

    // Validate user session
    if (!validateSession(sessionId, creator)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Validate entry fee
    const validEntryFees = [10, 20, 50, 100];
    if (!validEntryFees.includes(parseInt(entryFee))) {
      return res.status(400).json({ error: 'Invalid entry fee amount' });
    }

    // Only allow joining the existing continuous game
    const existingGame = activeGames[1];
    if (existingGame) {
      return res.json({ success: true, gameId: existingGame.id, existing: true });
    }

    // If no existing game found (shouldn't happen), create the continuous game
    const game = createContinuousGame();

    res.json({ success: true, gameId: game.id, existing: false });
  } catch (error) {
    console.error('Error in /api/create-game:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check for pending invitations
app.post('/api/check-invitations', (req, res) => {
  try {
    const { phone, sessionId, username } = req.body;

    // Validate user session
    if (!validateSession(sessionId, username)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Validate phone number
    if (!phone || !validator.isMobilePhone(phone, 'any')) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }

    const invitations = [];

    for (const invPhone in pendingInvitations) {
      if (invPhone === phone) {
        const invitation = pendingInvitations[invPhone];
        invitations.push(invitation);
      }
    }

    res.json({ success: true, invitations });
  } catch (error) {
    console.error('Error in /api/check-invitations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Join the continuous game
app.post('/api/join-game', (req, res) => {
  try {
    const { gameId, entryFee, sessionId, username } = req.body;

    // Validate user session
    if (!validateSession(sessionId, username)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Only allow joining game ID 1 (the continuous game)
    if (parseInt(gameId) !== 1 || !activeGames[1]) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const game = activeGames[1];

    if (game.entryFee !== parseInt(entryFee)) {
      return res.status(400).json({ error: 'Entry fee mismatch' });
    }

    if (Object.keys(game.players).length >= game.maxPlayers) {
      return res.status(400).json({ error: 'Game is full' });
    }

    // Validate user balance server-side
    const users = loadUsers();
    if (!users[username] || users[username].balance < game.entryFee) {
      return res.status(400).json({ error: 'Insufficient balance to join this game' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/join-game:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, phone } = req.body;

    // Input validation
    if (!username || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Sanitize inputs
    const sanitizedUsername = validator.escape(username.trim());
    const sanitizedPhone = validator.escape(phone.trim());

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (!validator.isMobilePhone(phone, 'any')) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }

    const users = loadUsers();

    // Check if user already exists
    if (users[sanitizedUsername]) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Check if phone number is already registered
    for (const user in users) {
      if (users[user].phone === sanitizedPhone) {
        return res.status(400).json({ error: 'Phone number already registered' });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    users[sanitizedUsername] = {
      password: hashedPassword,
      phone: sanitizedPhone,
      balance: 500.00,
      createdAt: new Date().toISOString()
    };

    saveUsers(users);

    res.json({
      success: true,
      message: 'Registration successful'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Input validation
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Sanitize inputs
    const sanitizedUsername = validator.escape(username.trim());

    const users = loadUsers();

    // Check if user exists
    const user = users[sanitizedUsername];
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    // Generate a session ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store session
    userSessions[sessionId] = {
      username: sanitizedUsername,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    res.json({
      success: true,
      message: 'Login successful',
      sessionId: sessionId,
      username: sanitizedUsername,
      balance: user.balance,
      phone: user.phone
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  try {
    const { sessionId } = req.body;

    if (sessionId && userSessions[sessionId]) {
      delete userSessions[sessionId];
    }

    res.json({ success: true, message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deposit funds
app.post('/api/deposit', (req, res) => {
  try {
    const { sessionId, amount } = req.body;

    // Validate session
    if (!sessionId || !userSessions[sessionId]) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const username = userSessions[sessionId].username;
    const users = loadUsers();

    if (!users[username]) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Validate amount
    if (isNaN(amount) || amount <= 0 || amount > 1000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Update balance
    users[username].balance += parseFloat(amount);
    saveUsers(users);

    // Update session activity
    userSessions[sessionId].lastActivity = new Date().toISOString();

    res.json({
      success: true,
      newBalance: users[username].balance
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Withdraw funds
app.post('/api/withdraw', (req, res) => {
  try {
    const { sessionId, amount } = req.body;

    // Validate session
    if (!sessionId || !userSessions[sessionId]) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const username = userSessions[sessionId].username;
    const users = loadUsers();

    if (!users[username]) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Validate amount
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check if user has sufficient balance
    if (users[username].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Update balance
    users[username].balance -= parseFloat(amount);
    saveUsers(users);

    // Update session activity
    userSessions[sessionId].lastActivity = new Date().toISOString();

    res.json({
      success: true,
      newBalance: users[username].balance
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Request deposit endpoint
app.post('/api/request-deposit', (req, res) => {
  try {
    const { sessionId, username, amount, bank, reference } = req.body;

    // Validate session
    if (!validateSession(sessionId, username)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Initialize if not exists
    if (!global.depositRequests) {
      global.depositRequests = [];
    }

    // Create deposit request
    const depositRequest = {
      id: `dep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username,
      amount: parseFloat(amount),
      bank: bank || 'telebirr',
      reference: reference || 'N/A',
      status: 'pending',
      createdAt: new Date().toISOString(),
      accountNumber: bankAccounts[bank]?.number || bankAccounts.telebirr.number,
      accountName: bankAccounts[bank]?.name || bankAccounts.telebirr.name
    };

    global.depositRequests.push(depositRequest);

    res.json({ success: true, depositRequest });
  } catch (error) {
    console.error('Error in /api/request-deposit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Request withdrawal endpoint
app.post('/api/request-withdrawal', (req, res) => {
  try {
    const { sessionId, username, amount, accountNumber, accountName, bank } = req.body;

    // Validate session
    if (!validateSession(sessionId, username)) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Check user balance
    const users = loadUsers();
    if (!users[username] || users[username].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Initialize if not exists
    if (!global.withdrawalRequests) {
      global.withdrawalRequests = [];
    }

    // Create withdrawal request
    const withdrawalRequest = {
      id: `wd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username,
      amount: parseFloat(amount),
      bank: bank || 'telebirr',
      accountNumber: accountNumber || 'N/A',
      accountName: accountName || 'N/A',
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // Deduct amount from user balance (will be returned if rejected)
    users[username].balance -= amount;
    saveUsers(users);

    global.withdrawalRequests.push(withdrawalRequest);

    res.json({ success: true, withdrawalRequest });
  } catch (error) {
    console.error('Error in /api/request-withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bank account information
app.get('/api/bank-accounts', (req, res) => {
  res.json(bankAccounts);
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;

    // Simple admin authentication
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      req.session.admin = true;
      res.json({ success: true, message: 'Admin login successful' });
    } else {
      res.status(401).json({ error: 'Invalid admin credentials' });
    }
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin logout
app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  try {
    req.session.destroy();
    res.json({ success: true, message: 'Admin logout successful' });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users for admin
app.get('/api/admin/users', requireAdminAuth, (req, res) => {
  try {
    const users = loadUsers();
    const userList = [];

    for (const username in users) {
      userList.push({
        username,
        phone: users[username].phone,
        balance: users[username].balance,
        createdAt: users[username].createdAt
      });
    }

    res.json(userList);
  } catch (error) {
    console.error('Error in /api/admin/users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get deposit requests for admin
app.get('/api/admin/deposits', requireAdminAuth, (req, res) => {
  try {
    res.json(global.depositRequests || []);
  } catch (error) {
    console.error('Error in /api/admin/deposits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get withdrawal requests for admin
app.get('/api/admin/withdrawals', requireAdminAuth, (req, res) => {
  try {
    res.json(global.withdrawalRequests || []);
  } catch (error) {
    console.error('Error in /api/admin/withdrawals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get winners for admin
app.get('/api/admin/winners', requireAdminAuth, (req, res) => {
  try {
    res.json(global.gameWinners || []);
  } catch (error) {
    console.error('Error in /api/admin/winners:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get game history for admin
app.get('/api/admin/game-history', requireAdminAuth, (req, res) => {
  try {
    res.json(global.gameHistory || []);
  } catch (error) {
    console.error('Error in /api/admin/game-history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve deposit request
app.post('/api/admin/approve-deposit', requireAdminAuth, (req, res) => {
  try {
    const { requestId } = req.body;

    const depositRequest = global.depositRequests.find(req => req.id === requestId);
    if (!depositRequest) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    // Update user balance
    const users = loadUsers();
    if (!users[depositRequest.username]) {
      return res.status(404).json({ error: 'User not found' });
    }

    users[depositRequest.username].balance += depositRequest.amount;
    saveUsers(users);

    // Update request status
    depositRequest.status = 'approved';
    depositRequest.approvedAt = new Date().toISOString();

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/admin/approve-deposit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject deposit request
app.post('/api/admin/reject-deposit', requireAdminAuth, (req, res) => {
  try {
    const { requestId } = req.body;

    const depositRequest = global.depositRequests.find(req => req.id === requestId);
    if (!depositRequest) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    // Update request status
    depositRequest.status = 'rejected';
    depositRequest.rejectedAt = new Date().toISOString();

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/admin/reject-deposit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve withdrawal request
app.post('/api/admin/approve-withdrawal', requireAdminAuth, (req, res) => {
  try {
    const { requestId } = req.body;

    const withdrawalRequest = global.withdrawalRequests.find(req => req.id === requestId);
    if (!withdrawalRequest) {
      return res.status(404).json({ error: 'Withdrawal request not found' });
    }

    // Update request status
    withdrawalRequest.status = 'approved';
    withdrawalRequest.approvedAt = new Date().toISOString();

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/admin/approve-withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject withdrawal request
app.post('/api/admin/reject-withdrawal', requireAdminAuth, (req, res) => {
  try {
    const { requestId } = req.body;

    const withdrawalRequest = global.withdrawalRequests.find(req => req.id === requestId);
    if (!withdrawalRequest) {
      return res.status(404).json({ error: 'Withdrawal request not found' });
    }

    // Return funds to user
    const users = loadUsers();
    if (users[withdrawalRequest.username]) {
      users[withdrawalRequest.username].balance += withdrawalRequest.amount;
      saveUsers(users);
    }

    // Update request status
    withdrawalRequest.status = 'rejected';
    withdrawalRequest.rejectedAt = new Date().toISOString();

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/admin/reject-withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve winner payout
app.post('/api/admin/approve-winner', requireAdminAuth, (req, res) => {
  try {
    const { winnerId } = req.body;

    const winner = global.gameWinners.find(w => w.id === winnerId);
    if (!winner) {
      return res.status(404).json({ error: 'Winner not found' });
    }

    // Update winner status
    winner.status = 'paid';
    winner.paidAt = new Date().toISOString();

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/admin/approve-winner:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining the continuous game
  socket.on('join-game', (data) => {
    const { gameId, entryFee, username, sessionId } = data;

    // Validate session
    if (!validateSession(sessionId, username)) {
      socket.emit('join-error', { error: 'Invalid session' });
      return;
    }

    // Only allow joining game ID 1 (the continuous game)
    if (parseInt(gameId) !== 1 || !activeGames[1]) {
      socket.emit('join-error', { error: 'Game not found' });
      return;
    }

    const game = activeGames[1];

    // Check if player is already in the game
    for (const playerSocketId in game.players) {
      if (game.players[playerSocketId].username === username) {
        socket.emit('join-error', { error: 'Already in this game' });
        return;
      }
    }

    // Add player to game
    const users = loadUsers();
    const user = users[username];

    if (!user) {
      socket.emit('join-error', { error: 'User not found' });
      return;
    }

    game.players[socket.id] = {
      username: username,
      balance: user.balance,
      card: [],
      hasBingo: false,
      ready: false,
      phone: user.phone,
      cardType: null,
      feeDeducted: false
    };

    // Join the socket room for this game
    socket.join(game.id);

    // Update prize pool
    game.prizePool = Object.keys(game.players).length * game.entryFee;

    // Send game state to the newly joined player
    socket.emit('game-state-update', sanitizeGameObject(game));

    // Broadcast updated game state to all players
    io.to(game.id).emit('game-state-update', sanitizeGameObject(game));

    // Broadcast player count update to all clients
    io.emit('player-count-update', {
      gameId: game.id,
      playerCount: Object.keys(game.players).length,
      gameStatus: game.gameStatus,
      timeRemaining: game.timeRemaining,
      calledNumbers: game.calledNumbers,
      currentNumber: game.currentNumber
    });

    console.log(`${username} joined game ${game.id}. Total players: ${Object.keys(game.players).length}`);
  });

  // Handle player card selection
  socket.on('select-card', (data) => {
    const { gameId, cardType, sessionId, username } = data;

    // Validate session
    if (!validateSession(sessionId, username)) {
      socket.emit('card-selection-error', { error: 'Invalid session' });
      return;
    }

    // Only allow joining game ID 1 (the continuous game)
    if (parseInt(gameId) !== 1 || !activeGames[1]) {
      socket.emit('card-selection-error', { error: 'Game not found' });
      return;
    }

    const game = activeGames[1];

    // Check if player is in the game
    if (!game.players[socket.id] || game.players[socket.id].username !== username) {
      socket.emit('card-selection-error', { error: 'Not in this game' });
      return;
    }

    // Generate a bingo card based on type
    let card = [];
    if (cardType === '4x4') {
      // Generate 4x4 card
      for (let i = 0; i < 4; i++) {
        const col = [];
        const min = i * 15 + 1;
        const max = min + 14;
        for (let j = 0; j < 4; j++) {
          col.push(Math.floor(Math.random() * (max - min + 1)) + min);
        }
        card.push(col);
      }
    } else {
      // Standard 5x5 card with free space
      for (let i = 0; i < 5; i++) {
        const col = [];
        const min = i * 15 + 1;
        const max = min + 14;
        for (let j = 0; j < 5; j++) {
          if (i === 2 && j === 2) {
            col.push('FREE');
          } else {
            col.push(Math.floor(Math.random() * (max - min + 1)) + min);
          }
        }
        card.push(col);
      }
    }

    // Update player's card
    game.players[socket.id].card = card;
    game.players[socket.id].cardType = cardType;
    game.players[socket.id].ready = true;

    // Send the card to the player
    socket.emit('card-generated', { card, cardType });

    // Broadcast updated game state to all players
    io.to(game.id).emit('game-state-update', sanitizeGameObject(game));

    console.log(`${username} selected a ${cardType} card in game ${game.id}`);
  });

  // Handle bingo claim
  socket.on('claim-bingo', (data) => {
    const { gameId, sessionId, username } = data;

    // Validate session
    if (!validateSession(sessionId, username)) {
      socket.emit('bingo-error', { error: 'Invalid session' });
      return;
    }

    // Only allow joining game ID 1 (the continuous game)
    if (parseInt(gameId) !== 1 || !activeGames[1]) {
      socket.emit('bingo-error', { error: 'Game not found' });
      return;
    }

    const game = activeGames[1];

    // Check if player is in the game
    if (!game.players[socket.id] || game.players[socket.id].username !== username) {
      socket.emit('bingo-error', { error: 'Not in this game' });
      return;
    }

    // Validate bingo
    const playerCard = game.players[socket.id].card;
    const isValidBingo = validateBingo(playerCard, game.calledNumbers);

    if (isValidBingo) {
      game.players[socket.id].hasBingo = true;

      // Determine winners
      const winners = determineWinners(game);

      if (winners.length > 0) {
        // Distribute prizes
        const prizeInfo = distributePrizes(game, winners);

        // Announce winners
        io.to(game.id).emit('winners-announced', {
          winners: winners,
          prizePool: game.prizePool,
          houseCut: prizeInfo.houseCut,
          prizePerWinner: prizeInfo.prizePerWinner
        });

        // Record game history
        global.gameHistory.push({
          id: game.id,
          date: new Date().toISOString(),
          prizePool: game.prizePool,
          winners: winners,
          playerCount: Object.keys(game.players).length
        });

        // End the game
        game.gameStatus = 'finished';

        // Reset the game after a brief delay for continuous play
        setTimeout(() => {
          resetGame(game);
        }, 5000); // 5 second delay before next card selection
      }

      console.log(`${username} has a valid BINGO in game ${game.id}!`);
    } else {
      socket.emit('bingo-error', { error: 'Invalid bingo claim' });
      console.log(`${username} made an invalid bingo claim in game ${game.id}`);
    }
  });

  // Handle player disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    handlePlayerDisconnect(socket.id);
  });

  // Handle manual game reset (admin only)
  socket.on('admin-reset-game', (data) => {
    const { sessionId, username } = data;

    // Validate session and admin status
    if (!validateSession(sessionId, username) || username !== process.env.ADMIN_USERNAME) {
      socket.emit('admin-error', { error: 'Admin access required' });
      return;
    }

    // Reset the continuous game
    if (activeGames[1]) {
      resetGame(activeGames[1]);
      socket.emit('admin-message', { message: 'Game reset successfully' });
    }
  });

  // Handle manual number call (admin only)
  socket.on('admin-call-number', (data) => {
    const { sessionId, username, number } = data;

    // Validate session and admin status
    if (!validateSession(sessionId, username) || username !== process.env.ADMIN_USERNAME) {
      socket.emit('admin-error', { error: 'Admin access required' });
      return;
    }

    // Call the number in the continuous game
    if (activeGames[1] && activeGames[1].gameStatus === 'playing') {
      const game = activeGames[1];
      const num = parseInt(number);

      if (!isNaN(num) && num >= 1 && num <= 75 && !game.calledNumbers.includes(num)) {
        game.currentNumber = num;
        game.calledNumbers.push(num);

        // Broadcast the new number to players
        io.to(game.id).emit('number-called', {
          number: num,
          allNumbers: game.calledNumbers,
          callIndex: game.calledNumbers.length
        });

        // Broadcast update to all clients for lobby display
        io.emit('player-count-update', {
          gameId: game.id,
          playerCount: Object.keys(game.players).length,
          gameStatus: game.gameStatus,
          timeRemaining: 0,
          calledNumbers: game.calledNumbers,
          currentNumber: game.currentNumber
        });

        socket.emit('admin-message', { message: `Number ${num} called successfully` });
      } else {
        socket.emit('admin-error', { error: 'Invalid number' });
      }
    } else {
      socket.emit('admin-error', { error: 'Game is not in playing state' });
    }
  });
});

// Initialize the continuous game when server starts
createContinuousGame();

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Bingo Bonanza server running on port ${PORT}`);
  console.log(`📍 Access your game at: http://167.71.48.61:${PORT}`);
  console.log(`🌐 Environment: ${isProduction ? 'Production' : 'Development'}`);
  console.log(`🔒 CORS allowed origins: ${allowedOrigins.join(', ')}`);
});
