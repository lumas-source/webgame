// script.js - COMPLETE BINGO GAME CLIENT WITH SYNCHRONIZED TIMERS - UPDATED
// Game state
let balance = parseFloat(localStorage.getItem('balance')) || 500.00;
let drawnNumbers = [];
let bingoCard = [];
let gameActive = false;
let voiceEnabled = true;
let currentNumber = null;
let markedNumbers = {};
let gamesPlayed = parseInt(localStorage.getItem('gamesPlayed')) || 0;
let playerCount = 0;
let entryFee = 10;
let prizePool = 0;
let houseCut = 0;
let winnerPrize = 0;
let selectedCardType = null;
let takenCards = new Set();
let currentPage = 1;
const cardsPerPage = 12;
const totalCardTypes = 400;
let cardSelectionTimer = 20;

// User session data
let sessionId = localStorage.getItem('sessionId');
let username = localStorage.getItem('username');
let userPhone = localStorage.getItem('phone');

// Check if user is logged in and has selected a game
const currentGame = localStorage.getItem('currentGame');

if (!sessionId || !username || !currentGame) {
    window.location.href = '/lobby';
}

// Card types with different probability distributions
const cardTypes = generateCardTypes(totalCardTypes);

// DOM elements with safe fallbacks
const balanceEl = document.getElementById('balanceAmount');
const mainBalanceEl = document.getElementById('mainBalanceAmount');
const bingoCardEl = document.getElementById('bingoCard');
const currentNumberEl = document.getElementById('currentNumber');
const currentNumberMiniEl = document.getElementById('currentNumberMini');
const calledNumbersEl = document.getElementById('calledNumbers');
const winModal = document.getElementById('winModal');
const winAmountEl = document.getElementById('winAmount');
const gameInfo = document.getElementById('gameInfo');
const bingoMainButton = document.getElementById('bingoMainButton');
const countdownEl = document.getElementById('countdown');
const countdownTextEl = document.getElementById('countdownText');
const gamesPlayedEl = document.getElementById('gamesPlayed');
const playerCountEl = document.getElementById('playerCount');
const prizePoolEl = document.getElementById('prizePool');
const cardSelectionModal = document.getElementById('cardSelectionModal');
const cardGrid = document.getElementById('cardGrid');
const randomCardBtn = document.getElementById('randomCardBtn');
const startGameBtn = document.getElementById('startGameBtn');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfoEl = document.getElementById('pageInfo');
const cardSelectionCountdownEl = document.getElementById('cardSelectionCountdown');

// Initialize socket connection
const socket = io();

// Socket.io connection setup
function setupSocketListeners() {
    // Handle connection events
    socket.on('connect', () => {
        console.log('Connected to server');
        if (gameInfo) gameInfo.textContent = "Connected to game server";

        // Request current game state from server
        socket.emit('request-game-state');
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        if (gameInfo) gameInfo.textContent = "Disconnected. Reconnecting...";
    });

    socket.on('reconnect', () => {
        console.log('Reconnected to server');
        if (gameInfo) gameInfo.textContent = "Reconnected to game server";

        // Rejoin the game after reconnection
        const gameData = JSON.parse(currentGame);
        socket.emit('player-join-game', {
            username: username,
            balance: balance,
            phone: userPhone,
            gameId: gameData.id,
            sessionId: sessionId
        });
    });

    socket.on('connect_error', (error) => {
        console.log('Connection error:', error);
        if (gameInfo) gameInfo.textContent = "Connection error. Please refresh the page.";
    });

    // Listen for game state updates from server
    socket.on('game-state-update', (state) => {
        console.log('Server game state:', state);
        playerCount = Object.keys(state.players || {}).length;
        prizePool = state.prizePool || playerCount * entryFee;
        gameActive = state.gameStatus === 'playing';

        // Update taken cards based on server state
        updateTakenCards(state.players);

        updateStats();

        // If game is active and we have a card, show the game board
        if (gameActive && bingoCard.length > 0 && cardSelectionModal) {
            cardSelectionModal.style.display = 'none';
        }

        // If game is active and we don't have a card yet, show waiting message
        if (gameActive && bingoCard.length === 0 && cardSelectionModal) {
            if (gameInfo) gameInfo.textContent = "Game in progress. Please wait for the next round.";
            if (cardSelectionModal) cardSelectionModal.style.display = 'none';
        }
    });

    // Listen for player count updates
    socket.on('player-count-update', (data) => {
        if (playerCountEl) playerCountEl.textContent = data.playerCount;
        playerCount = data.playerCount;

        // Update prize pool based on player count
        prizePool = playerCount * entryFee;
        if (prizePoolEl) prizePoolEl.textContent = prizePool.toLocaleString();

        updateStats();
    });

    // Listen for card selection time updates from server
    socket.on('card-selection-time-update', (data) => {
        cardSelectionTimer = data.timeRemaining;

        if (cardSelectionCountdownEl) {
            if (cardSelectionTimer > 0) {
                cardSelectionCountdownEl.textContent = `Game starting in ${cardSelectionTimer} seconds`;
                cardSelectionCountdownEl.style.display = 'block';
            } else {
                cardSelectionCountdownEl.style.display = 'none';
            }
        }

        // If time runs out and no card selected, choose a random available card
        if (cardSelectionTimer <= 0 && !selectedCardType) {
            selectRandomCard();
            startGameWithSelectedCard();
        }
    });

    // Listen for numbers called by the server
    socket.on('number-called', (data) => {
        console.log('Number called by server:', data.number);
        currentNumber = data.number;
        drawnNumbers = data.allNumbers || [];

        // Update UI with the server's number
        if (currentNumberEl) currentNumberEl.textContent = currentNumber;
        if (currentNumberMiniEl) currentNumberMiniEl.textContent = currentNumber;

        // Add to called numbers list
        if (calledNumbersEl) {
            const calledNumberEl = document.createElement('div');
            calledNumberEl.className = 'called-number';
            calledNumberEl.textContent = getNumberWithLetter(data.number);
            calledNumbersEl.appendChild(calledNumberEl);
            calledNumbersEl.scrollTop = calledNumbersEl.scrollHeight;
        }

        // Highlight the number on the card
        if (bingoCardEl) {
            document.querySelectorAll('.bingo-cell').forEach(cell => {
                if (parseInt(cell.dataset.value) === data.number) {
                    cell.style.boxShadow = '0 0 8px yellow';
                    setTimeout(() => {
                        cell.style.boxShadow = '';
                    }, 1000);
                }
            });
        }

        if (gameInfo) gameInfo.textContent = `Current: ${getNumberWithLetter(data.number)}`;

        // Speak the number
        if (voiceEnabled) {
            speakNumber(data.number);
        }
    });

    // Listen for game start signal from server
    socket.on('game-started', () => {
        console.log('Server started the game!');
        gameActive = true;
        if (gameInfo) gameInfo.textContent = "Game is active! Mark numbers as they are called!";

        // Hide card selection modal if it's visible
        if (cardSelectionModal) {
            cardSelectionModal.style.display = 'none';
        }

        // Update balance after fee deduction
        updateBalanceFromServer();
    });

    // Listen for win announcements
    socket.on('player-wins', (data) => {
        if (data.playerName === username) {
            // This player won!
            if (winAmountEl) winAmountEl.textContent = data.prize.toLocaleString();
            if (winModal) winModal.style.display = 'flex';
            balance = data.newBalance;
            gamesPlayed++;
            localStorage.setItem('gamesPlayed', gamesPlayed);
            if (gamesPlayedEl) gamesPlayedEl.textContent = gamesPlayed;
            updateBalance();
            gameActive = false;

            // Start the countdown for the next game
            startCountdown();
        } else {
            // Another player won
            if (gameInfo) gameInfo.textContent = `${data.playerName} won ${data.prize} Birr! House cut: ${data.houseCut} Birr`;
            setTimeout(() => {
                resetGame();
            }, 3000);
        }
    });

    // Listen for winners announcement
    socket.on('winners-announced', (data) => {
        const winnerNames = data.winners.map(w => w.username).join(', ');
        if (data.winners.some(winner => winner.username === username)) {
            // This player won!
            if (winAmountEl) winAmountEl.textContent = data.prizePerWinner.toLocaleString();
            if (winModal) winModal.style.display = 'flex';
            updateBalanceFromServer();
            gamesPlayed++;
            localStorage.setItem('gamesPlayed', gamesPlayed);
            if (gamesPlayedEl) gamesPlayedEl.textContent = gamesPlayed;
            gameActive = false;

            if (gameInfo) gameInfo.textContent = `You won ${data.prizePerWinner} Birr! House cut: ${data.houseCut} Birr`;
        } else {
            // Other players won
            if (gameInfo) gameInfo.textContent = `${winnerNames} won ${data.prizePerWinner} Birr each! House cut: ${data.houseCut} Birr`;
        }

        // Start the countdown for the next game
        startCountdown();
    });

    // Listen for no winners
    socket.on('no-winners', (data) => {
        if (gameInfo) gameInfo.textContent = data.message;
        setTimeout(() => {
            resetGame();
        }, 3000);
    });

    // Listen for invalid bingo claims
    socket.on('bingo-invalid', (data) => {
        if (gameInfo) gameInfo.textContent = data.message;
        setTimeout(() => {
            if (gameActive && gameInfo) gameInfo.textContent = "Mark numbers as they are called!";
        }, 3000);
    });

    // Listen for game reset
    socket.on('game-reset', () => {
        resetGame();
    });

    // Listen for game cancellation
    socket.on('game-cancelled', (data) => {
        if (gameInfo) gameInfo.textContent = data.message;
        alert(data.message);

        // Redirect back to lobby after a delay
        setTimeout(() => {
            window.location.href = '/lobby';
        }, 3000);
    });

    // Listen for game errors
    socket.on('game-error', (data) => {
        if (gameInfo) gameInfo.textContent = data.message;
        alert(data.message);
    });
}

// Update balance from server
function updateBalanceFromServer() {
    fetch('/api/user-info', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionId: sessionId,
            username: username
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                balance = data.balance;
                localStorage.setItem('balance', balance);
                updateBalance();
            }
        })
        .catch(error => {
            console.error('Error fetching user info:', error);
        });
}

// Update taken cards based on server player data
function updateTakenCards(players) {
    if (!players) return;

    // Reset taken cards
    takenCards = new Set();

    // Mark cards as taken based on server data only for current players
    Object.values(players).forEach(player => {
        if (player.cardType && player.cardType !== null) {
            // Mark the specific card type as taken
            takenCards.add(player.cardType);
        }
    });

    // Regenerate card options to reflect taken status
    generateCardOptionsForPage(currentPage);
}

// Initialize the game
function initGame() {
    console.log('Initializing game connection to server...');

    // Connect to server events
    setupSocketListeners();

    // Generate card selection options for first page
    generateCardOptionsForPage(1);
    updatePagination();

    // Show card selection modal
    if (cardSelectionModal) cardSelectionModal.style.display = 'flex';

    // Event listeners
    if (bingoMainButton) bingoMainButton.addEventListener('click', checkBingo);
    if (randomCardBtn) randomCardBtn.addEventListener('click', selectRandomCard);
    if (startGameBtn) startGameBtn.addEventListener('click', startGameWithSelectedCard);
    if (prevPageBtn) prevPageBtn.addEventListener('click', goToPrevPage);
    if (nextPageBtn) nextPageBtn.addEventListener('click', goToNextPage);

    // Update stats
    updateBalance();
    updateStats();

    // Tell the server we're joining the game with session validation
    const gameData = JSON.parse(currentGame);
    entryFee = gameData.entryFee || 10;

    socket.emit('player-join-game', {
        username: username,
        balance: balance,
        phone: userPhone,
        gameId: gameData.id,
        sessionId: sessionId
    });
}

// Pagination functions
function goToPrevPage() {
    if (currentPage > 1) {
        currentPage--;
        generateCardOptionsForPage(currentPage);
        updatePagination();
    }
}

function goToNextPage() {
    const totalPages = Math.ceil(totalCardTypes / cardsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        generateCardOptionsForPage(currentPage);
        updatePagination();
    }
}

function updatePagination() {
    const totalPages = Math.ceil(totalCardTypes / cardsPerPage);
    if (pageInfoEl) pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;

    if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
    if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
}

// Generate card selection options for a specific page
function generateCardOptionsForPage(page) {
    if (!cardGrid) return;

    cardGrid.innerHTML = '';

    const startIndex = (page - 1) * cardsPerPage;
    const endIndex = Math.min(startIndex + cardsPerPage, totalCardTypes);

    for (let i = startIndex; i < endIndex; i++) {
        const card = cardTypes[i];
        const cardElement = document.createElement('div');
        cardElement.className = 'card-option';
        if (takenCards.has(card.id)) {
            cardElement.classList.add('taken');
        }

        cardElement.innerHTML = `
      <div class="card-type">${card.name}</div>
      <div class="card-desc">${card.desc}</div>
      <div class="card-probability">Win Probability: ${card.probabilityPercent}</div>
      ${takenCards.has(card.id) ? '<div class="card-desc">(Taken)</div>' : ''}
    `;

        if (!takenCards.has(card.id)) {
            cardElement.addEventListener('click', () => selectCard(card.id, cardElement));
        }

        cardGrid.appendChild(cardElement);
    }
}

// Select a card
function selectCard(cardId, cardElement) {
    // Remove selected class from all cards
    document.querySelectorAll('.card-option').forEach(card => {
        card.classList.remove('selected');
    });

    // Add selected class to clicked card
    cardElement.classList.add('selected');

    // Store selected card
    selectedCardType = cardId;
}

// Select a random available card
function selectRandomCard() {
    const availableCards = [];

    // Get all available card options from the DOM
    document.querySelectorAll('.card-option').forEach(cardEl => {
        if (!cardEl.classList.contains('taken')) {
            const cardTypeEl = cardEl.querySelector('.card-type');
            if (cardTypeEl) {
                const cardId = parseInt(cardTypeEl.textContent.split(' ')[1]);
                if (!isNaN(cardId)) {
                    availableCards.push({
                        element: cardEl,
                        id: cardId
                    });
                }
            }
        }
    });

    if (availableCards.length > 0) {
        const randomCard = availableCards[Math.floor(Math.random() * availableCards.length)];
        selectedCardType = randomCard.id;

        // Select the card in the UI
        document.querySelectorAll('.card-option').forEach(cardEl => {
            cardEl.classList.remove('selected');
        });

        randomCard.element.classList.add('selected');

        // Scroll into view if needed
        randomCard.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
        alert('No available cards. Please wait for the next game.');
    }
}

// Start game with selected card
function startGameWithSelectedCard() {
    if (!selectedCardType) {
        alert('Please select a card type first!');
        return;
    }

    if (takenCards.has(selectedCardType)) {
        alert('This card is already taken. Please select another card.');
        return;
    }

    // Generate the bingo card UI
    generateBingoCard();

    // Send the card data to the server for validation with session info
    socket.emit('player-card-selected', {
        cardType: selectedCardType,
        cardData: bingoCard,
        sessionId: sessionId
    });

    if (gameInfo) gameInfo.textContent = "Card selected. Waiting for game to start...";

    // Hide the card selection modal
    if (cardSelectionModal) {
        cardSelectionModal.style.display = 'none';
    }
}

// Update stats display
function updateStats() {
    if (playerCountEl) playerCountEl.textContent = playerCount;
    if (prizePoolEl) prizePoolEl.textContent = prizePool.toLocaleString();
    if (gamesPlayedEl) gamesPlayedEl.textContent = gamesPlayed;

    if (currentNumber && currentNumberMiniEl) {
        currentNumberMiniEl.textContent = currentNumber;
    }
}

// Generate a random Bingo card based on selected card type's probability
function generateBingoCard() {
    if (!bingoCardEl) return;

    bingoCardEl.innerHTML = '';
    bingoCard = [];
    markedNumbers = {};

    // Get the selected card type's probability distribution
    const selectedCard = cardTypes.find(card => card.id === selectedCardType);
    const probability = selectedCard ? selectedCard.probability : {
        B: 1, I: 1, N: 1, G: 1, O: 1
    };

    // Generate numbers for each column with probability weighting
    const ranges = [
        { min: 1, max: 15, letter: 'B', weight: probability.B },
        { min: 16, max: 30, letter: 'I', weight: probability.I },
        { min: 31, max: 45, letter: 'N', weight: probability.N },
        { min: 46, max: 60, letter: 'G', weight: probability.G },
        { min: 61, max: 75, letter: 'O', weight: probability.O }
    ];

    for (let col = 0; col < 5; col++) {
        let colNumbers = [];
        let min = ranges[col].min;
        let max = ranges[col].max;
        let weight = ranges[col].weight;

        for (let row = 0; row < 5; row++) {
            if (col === 2 && row === 2) {
                // Free space in the center
                colNumbers.push('FREE');
            } else {
                let num;
                let attempts = 0;
                let foundUnique = false;

                // Generate unique numbers for this column
                do {
                    // Apply probability weighting - higher weight means more numbers in this range
                    let baseNum = Math.floor(Math.random() * (max - min + 1)) + min;

                    // If weight is high, we're more likely to keep this number
                    if (Math.random() < (weight / 2)) {
                        num = baseNum;
                    } else {
                        // Otherwise try a different approach
                        num = Math.floor(Math.random() * (max - min + 1)) + min;
                    }

                    // Check if this number is already in the column
                    if (!colNumbers.includes(num)) {
                        foundUnique = true;
                    }

                    attempts++;
                    // Fallback to prevent infinite loops
                    if (attempts > 20) {
                        // Just find any available number
                        for (let n = min; n <= max; n++) {
                            if (!colNumbers.includes(n)) {
                                num = n;
                                foundUnique = true;
                                break;
                            }
                        }
                        if (!foundUnique) {
                            // Last resort - use a random number
                            num = Math.floor(Math.random() * (max - min + 1)) + min;
                            foundUnique = true;
                        }
                    }
                } while (!foundUnique);

                colNumbers.push(num);
            }
        }
        bingoCard.push(colNumbers);
    }

    // Render the card
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const cell = document.createElement('div');
            cell.className = 'bingo-cell';

            if (row === 2 && col === 2) {
                cell.classList.add('free');
                cell.textContent = 'FREE';
                cell.dataset.value = 'FREE';
            } else {
                cell.textContent = bingoCard[col][row];
                cell.dataset.value = bingoCard[col][row];
            }

            cell.dataset.row = row;
            cell.dataset.col = col;
            cell.addEventListener('click', () => toggleCell(cell));
            bingoCardEl.appendChild(cell);
        }
    }
}

// Toggle cell selection only if the number has been called
function toggleCell(cell) {
    if (!gameActive) return;

    const cellValue = cell.dataset.value;

    if (cellValue === 'FREE') {
        cell.classList.toggle('selected');
        return;
    }

    const num = parseInt(cellValue);

    // Only allow marking if the number has been called
    if (drawnNumbers.includes(num)) {
        cell.classList.toggle('selected');

        // Record when this number was marked
        markedNumbers[num] = drawnNumbers.indexOf(num);
    } else {
        // Visual feedback that this number hasn't been called yet
        cell.style.transform = 'scale(1.1)';
        setTimeout(() => {
            cell.style.transform = 'scale(1)';
        }, 300);
    }
}

// Get the letter for a number (B, I, N, G, O)
function getNumberWithLetter(num) {
    if (num <= 15) return `B${num}`;
    if (num <= 30) return `I${num}`;
    if (num <= 45) return `N${num}`;
    if (num <= 60) return `G${num}`;
    return `O${num}`;
}

// Speak a number using the speech synthesis API
function speakNumber(num) {
    if ('speechSynthesis' in window && voiceEnabled) {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(getNumberWithLetter(num));
        utterance.rate = 0.9;
        utterance.pitch = 1.1;

        // Try to use a English voice
        const voices = speechSynthesis.getVoices();
        const englishVoice = voices.find(voice =>
            voice.lang.includes('en')
        );

        if (englishVoice) {
            utterance.voice = englishVoice;
        }

        window.speechSynthesis.speak(utterance);
    }
}

// Check for winning pattern
function checkBingo() {
    if (!gameActive) return;

    // Check rows
    for (let row = 0; row < 5; row++) {
        let rowValid = true;
        for (let col = 0; col < 5; col++) {
            // Skip free space
            if (row === 2 && col === 2) continue;

            const cell = document.querySelector(`.bingo-cell[data-row="${row}"][data-col="${col}"]`);

            // Check if the cell is selected
            if (!cell || !cell.classList.contains('selected')) {
                rowValid = false;
                break;
            }
        }
        if (rowValid) {
            // Tell the server we claim BINGO!
            socket.emit('player-bingo-claim');
            if (gameInfo) gameInfo.textContent = "BINGO claimed! Verifying...";
            return;
        }
    }

    // Check columns
    for (let col = 0; col < 5; col++) {
        let colValid = true;
        for (let row = 0; row < 5; row++) {
            // Skip free space
            if (row === 2 && col === 2) continue;

            const cell = document.querySelector(`.bingo-cell[data-row="${row}"][data-col="${col}"]`);

            // Check if the cell is selected
            if (!cell || !cell.classList.contains('selected')) {
                colValid = false;
                break;
            }
        }
        if (colValid) {
            // Tell the server we claim BINGO!
            socket.emit('player-bingo-claim');
            if (gameInfo) gameInfo.textContent = "BINGO claimed! Verifying...";
            return;
        }
    }

    // Check diagonals
    let diag1Valid = true; // Top-left to bottom-right
    let diag2Valid = true; // Top-right to bottom-left

    for (let i = 0; i < 5; i++) {
        // Top-left to bottom-right diagonal
        if (i !== 2) { // Skip center (free space)
            const cell1 = document.querySelector(`.bingo-cell[data-row="${i}"][data-col="${i}"]`);
            if (!cell1 || !cell1.classList.contains('selected')) {
                diag1Valid = false;
            }
        }

        // Top-right to bottom-left diagonal
        const colIndex = 4 - i;
        if (!(i === 2 && colIndex === 2)) { // Skip center (free space)
            const cell2 = document.querySelector(`.bingo-cell[data-row="${i}"][data-col="${colIndex}"]`);
            if (!cell2 || !cell2.classList.contains('selected')) {
                diag2Valid = false;
            }
        }
    }

    if (diag1Valid || diag2Valid) {
        // Tell the server we claim BINGO!
        socket.emit('player-bingo-claim');
        if (gameInfo) gameInfo.textContent = "BINGO claimed! Verifying...";
        return;
    }

    if (gameInfo) gameInfo.textContent = "No winning pattern yet. Keep playing!";
    setTimeout(() => {
        if (gameActive && gameInfo) gameInfo.textContent = "Mark numbers as they are called!";
    }, 2000);
}

// Start countdown for next game
function startCountdown() {
    let seconds = 5;
    if (countdownEl) countdownEl.style.display = 'block';
    if (countdownTextEl) countdownTextEl.style.display = 'block';

    const restartTimer = setInterval(() => {
        if (countdownEl) countdownEl.textContent = seconds;
        if (countdownTextEl) countdownTextEl.textContent = seconds;

        if (seconds <= 0) {
            clearInterval(restartTimer);
            if (countdownEl) countdownEl.style.display = 'none';
            if (countdownTextEl) countdownTextEl.style.display = 'none';
            resetGame();
        }

        seconds--;
    }, 1000);
}

// Reset the game
function resetGame() {
    drawnNumbers = [];
    currentNumber = null;
    if (currentNumberEl) currentNumberEl.textContent = '-';
    if (currentNumberMiniEl) currentNumberMiniEl.textContent = '-';
    if (calledNumbersEl) calledNumbersEl.innerHTML = '';
    document.querySelectorAll('.bingo-cell').forEach(cell => {
        cell.classList.remove('selected');
        cell.style.boxShadow = '';
    });
    if (winModal) winModal.style.display = 'none';
    if (countdownEl) countdownEl.style.display = 'none';
    if (countdownTextEl) countdownTextEl.style.display = 'none';

    // Show card selection again for next game
    selectedCardType = null;
    bingoCard = [];

    // Request updated game state from server
    socket.emit('request-game-state');

    // Show card selection modal if game is not active
    if (!gameActive && cardSelectionModal) {
        cardSelectionModal.style.display = 'flex';
    }
}

// Update balance display
function updateBalance() {
    if (balanceEl) balanceEl.textContent = balance.toFixed(2);
    if (mainBalanceEl) mainBalanceEl.textContent = balance.toFixed(2);
}

// Card types generation function
function generateCardTypes(count) {
    const types = [];

    for (let i = 1; i <= count; i++) {
        const probabilityProfile = i % 10;
        let name, desc, probabilityFactor;

        switch (probabilityProfile) {
            case 0:
                name = "Lucky " + i;
                desc = "High probability for B column";
                probabilityFactor = { B: 1.5, I: 0.8, N: 0.9, G: 1.0, O: 0.8 };
                break;
            case 1:
                name = "Fortune " + i;
                desc = "High probability for I column";
                probabilityFactor = { B: 0.8, I: 1.5, N: 0.9, G: 1.0, O: 0.8 };
                break;
            case 2:
                name = "Chance " + i;
                desc = "High probability for N column";
                probabilityFactor = { B: 0.9, I: 0.8, N: 1.5, G: 1.0, O: 0.8 };
                break;
            case 3:
                name = "Victory " + i;
                desc = "High probability for G column";
                probabilityFactor = { B: 0.8, I: 0.9, N: 1.0, G: 1.5, O: 0.8 };
                break;
            case 4:
                name = "Winner " + i;
                desc = "High probability for O column";
                probabilityFactor = { B: 0.8, I: 0.9, N: 1.0, G: 0.8, O: 1.5 };
                break;
            case 5:
                name = "Jackpot " + i;
                desc = "Balanced with slightly higher odds";
                probabilityFactor = { B: 1.1, I: 1.1, N: 1.1, G: 1.1, O: 1.1 };
                break;
            case 6:
                name = "Premium " + i;
                desc = "Higher odds for extreme numbers";
                probabilityFactor = { B: 1.3, I: 1.1, N: 0.9, G: 1.1, O: 1.3 };
                break;
            case 7:
                name = "Elite " + i;
                desc = "Focused on middle numbers";
                probabilityFactor = { B: 0.7, I: 1.2, N: 1.4, G: 1.2, O: 0.7 };
                break;
            case 8:
                name = "Special " + i;
                desc = "Random distribution pattern";
                probabilityFactor = {
                    B: 0.8 + Math.random() * 0.7,
                    I: 0.8 + Math.random() * 0.7,
                    N: 0.8 + Math.random() * 0.7,
                    G: 0.8 + Math.random() * 0.7,
                    O: 0.8 + Math.random() * 0.7
                };
                break;
            case 9:
                name = "Unique " + i;
                desc = "Custom probability distribution";
                probabilityFactor = {
                    B: 0.9 + Math.random() * 0.6,
                    I: 0.9 + Math.random() * 0.6,
                    N: 0.9 + Math.random() * 0.6,
                    G: 0.9 + Math.random() * 0.6,
                    O: 0.9 + Math.random() * 0.6
                };
                break;
        }

        const totalProbability = Object.values(probabilityFactor).reduce((sum, val) => sum + val, 0);
        const avgProbability = (totalProbability / 5 * 20).toFixed(1);

        types.push({
            id: i,
            name: name,
            desc: desc,
            probability: probabilityFactor,
            probabilityPercent: avgProbability + '%'
        });
    }

    return types;
}

// Initialize the game when page loads
window.addEventListener('load', initGame);