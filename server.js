const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Раздаём статику
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Класс карты
class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
        this.trump = false;
    }
    
    toString() {
        return `${this.rank}_${this.suit}`;
    }
    
    static getRankValue(rank) {
        const values = {
            '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
            'J': 11, 'Q': 12, 'K': 13, 'A': 14
        };
        return values[rank] || 0;
    }
    
    canBeat(otherCard) {
        if (this.trump && !otherCard.trump) return true;
        if (!this.trump && !otherCard.trump && this.suit === otherCard.suit) {
            return Card.getRankValue(this.rank) > Card.getRankValue(otherCard.rank);
        }
        if (this.trump && otherCard.trump) {
            return Card.getRankValue(this.rank) > Card.getRankValue(otherCard.rank);
        }
        return false;
    }
}

// Класс игровой комнаты
class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.deck = [];
        this.trumpCard = null;
        this.table = [];
        this.gameStarted = false;
        this.attacker = 0;
        this.defender = 1;
        this.turnPhase = 'attack';
        this.maxCards = 6;
    }
    
    addPlayer(player) {
        if (this.players.length < 4 && !this.gameStarted) {
            this.players.push(player);
            return true;
        }
        return false;
    }
    
    startGame() {
        if (this.players.length >= 2) {
            this.initializeDeck();
            this.dealCards();
            this.gameStarted = true;
            this.attacker = 0;
            this.defender = 1;
            return true;
        }
        return false;
    }
    
    initializeDeck() {
        const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
        const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        
        this.deck = [];
        suits.forEach(suit => {
            ranks.forEach(rank => {
                this.deck.push(new Card(suit, rank));
            });
        });
        
        // Перемешиваем
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
        
        // Определяем козырь
        this.trumpCard = this.deck[this.deck.length - 1];
        this.deck.forEach(card => {
            card.trump = card.suit === this.trumpCard.suit;
        });
    }
    
    dealCards() {
        this.players.forEach(player => {
            while (player.hand.length < this.maxCards && this.deck.length > 0) {
                player.hand.push(this.deck.pop());
            }
        });
    }
    
    getGameState() {
        return {
            type: 'game_state',
            trumpCard: this.trumpCard ? this.trumpCard.toString() : null,
            deckSize: this.deck.length,
            table: this.table.map(pair => ({
                attack: pair.attack.toString(),
                defend: pair.defend ? pair.defend.toString() : null
            })),
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                cardCount: p.hand.length
            })),
            attacker: this.players[this.attacker]?.id,
            defender: this.players[this.defender]?.id,
            turnPhase: this.turnPhase,
            currentPlayer: this.players[this.turnPhase === 'defense' ? this.defender : this.attacker]?.id
        };
    }
    
    playerAttack(playerId, cardString) {
        if (this.turnPhase === 'defense') return false;
        
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.id !== this.players[this.attacker].id) return false;
        
        const [rank, suit] = cardString.split('_');
        const cardIndex = player.hand.findIndex(c => c.rank === rank && c.suit === suit);
        if (cardIndex === -1) return false;
        
        const card = player.hand[cardIndex];
        
        // Проверяем можно ли подкинуть
        if (this.table.length > 0) {
            const ranksOnTable = new Set();
            this.table.forEach(pair => {
                ranksOnTable.add(pair.attack.rank);
                if (pair.defend) ranksOnTable.add(pair.defend.rank);
            });
            
            if (!ranksOnTable.has(card.rank)) return false;
        }
        
        player.hand.splice(cardIndex, 1);
        this.table.push({ attack: card, defend: null });
        this.turnPhase = 'defense';
        
        return true;
    }
    
    playerDefend(pairIndex, cardString) {
        if (this.turnPhase !== 'defense') return false;
        
        const player = this.players.find(p => p.id === this.players[this.defender].id);
        if (!player) return false;
        
        const [rank, suit] = cardString.split('_');
        const cardIndex = player.hand.findIndex(c => c.rank === rank && c.suit === suit);
        if (cardIndex === -1) return false;
        
        const card = player.hand[cardIndex];
        const attackCard = this.table[pairIndex].attack;
        
        if (!card.canBeat(attackCard)) return false;
        
        player.hand.splice(cardIndex, 1);
        this.table[pairIndex].defend = card;
        
        // Проверяем все ли карты отбиты
        if (this.table.every(pair => pair.defend)) {
            this.turnPhase = 'attack';
        }
        
        return true;
    }
    
    playerTakeCards() {
        if (this.turnPhase !== 'defense') return false;
        
        const defender = this.players[this.defender];
        
        this.table.forEach(pair => {
            defender.hand.push(pair.attack);
            if (pair.defend) defender.hand.push(pair.defend);
        });
        
        this.table = [];
        this.nextTurn();
        return true;
    }
    
    nextTurn() {
        this.table = [];
        this.attacker = (this.attacker + 1) % this.players.length;
        this.defender = (this.defender + 1) % this.players.length;
        
        this.dealCards();
        this.turnPhase = 'attack';
        
        this.checkWinner();
    }
    
    checkWinner() {
        const winner = this.players.find(p => p.hand.length === 0 && this.deck.length === 0);
        if (winner) {
            this.broadcast({
                type: 'game_over',
                winner: winner.name,
                winnerId: winner.id
            });
        }
    }
    
    broadcast(message, excludePlayerId = null) {
        this.players.forEach(player => {
            if (player.id !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify(message));
            }
        });
    }
    
    sendToPlayer(playerId, message) {
        const player = this.players.find(p => p.id === playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    }
}

// Хранилище комнат
const gameRooms = new Map();

// WebSocket обработка
wss.on('connection', (ws) => {
    ws.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    
    console.log(`Новое подключение: ${ws.id}`);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'create_room':
                    handleCreateRoom(ws, data);
                    break;
                case 'join_room':
                    handleJoinRoom(ws, data);
                    break;
                case 'start_game':
                    handleStartGame(ws, data);
                    break;
                case 'game_action':
                    handleGameAction(ws, data);
                    break;
                case 'chat_message':
                    handleChatMessage(ws, data);
                    break;
            }
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Ошибка обработки сообщения'
            }));
        }
    });
    
    ws.on('close', () => {
        handlePlayerDisconnect(ws);
    });
});

function handleCreateRoom(ws, data) {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = new GameRoom(roomId);
    gameRooms.set(roomId, room);
    
    ws.send(JSON.stringify({
        type: 'room_created',
        roomId: roomId
    }));
}

function handleJoinRoom(ws, data) {
    const room = gameRooms.get(data.roomId);
    if (!room) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Комната не найдена'
        }));
        return;
    }
    
    if (room.gameStarted) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Игра уже началась'
        }));
        return;
    }
    
    const player = {
        id: ws.id,
        name: data.playerName || `Игрок ${room.players.length + 1}`,
        hand: [],
        ws: ws
    };
    
    if (room.addPlayer(player)) {
        ws.roomId = data.roomId;
        ws.playerId = ws.id;
        
        ws.send(JSON.stringify({
            type: 'joined_room',
            roomId: data.roomId,
            playerId: ws.id,
            playerName: player.name,
            playerCount: room.players.length
        }));
        
        room.broadcast({
            type: 'player_joined',
            playerName: player.name,
            playerCount: room.players.length,
            players: room.players.map(p => ({ id: p.id, name: p.name }))
        });
    }
}

function handleStartGame(ws, data) {
    const room = gameRooms.get(data.roomId);
    if (!room || room.gameStarted) return;
    
    if (room.startGame()) {
        room.players.forEach(player => {
            const gameState = {
                ...room.getGameState(),
                hand: player.hand.map(card => card.toString())
            };
            room.sendToPlayer(player.id, gameState);
        });
    }
}

function handleGameAction(ws, data) {
    const room = gameRooms.get(data.roomId);
    if (!room || !room.gameStarted) return;
    
    const player = room.players.find(p => p.id === ws.id);
    if (!player) return;
    
    let success = false;
    
    switch(data.action) {
        case 'attack':
            success = room.playerAttack(ws.id, data.card);
            break;
        case 'defend':
            success = room.playerDefend(data.pairIndex, data.card);
            break;
        case 'take':
            success = room.playerTakeCards();
            break;
        case 'pass':
            if (room.turnPhase === 'attack' && room.table.length > 0) {
                room.turnPhase = 'defense';
                success = true;
            }
            break;
    }
    
    if (success) {
        updateGameState(room);
    } else {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Невозможно выполнить это действие'
        }));
    }
}

function updateGameState(room) {
    room.players.forEach(player => {
        const gameState = {
            ...room.getGameState(),
            hand: player.hand.map(card => card.toString())
        };
        room.sendToPlayer(player.id, gameState);
    });
}

function handleChatMessage(ws, data) {
    const room = gameRooms.get(data.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === ws.id);
    if (!player) return;
    
    room.broadcast({
        type: 'chat_message',
        playerName: player.name,
        message: data.message.substring(0, 200)
    });
}

function handlePlayerDisconnect(ws) {
    const roomId = ws.roomId;
    if (!roomId) return;
    
    const room = gameRooms.get(roomId);
    if (!room) return;
    
    const playerIndex = room.players.findIndex(p => p.id === ws.id);
    if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
            gameRooms.delete(roomId);
        } else {
            room.broadcast({
                type: 'player_left',
                playerCount: room.players.length,
                players: room.players.map(p => ({ id: p.id, name: p.name }))
            });
            
            if (room.gameStarted) {
                room.broadcast({
                    type: 'player_disconnected',
                    message: 'Игрок отключился. Игра приостановлена.'
                });
            }
        }
    }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Сервер игры "Дурак" запущен на порту ${PORT}`);
});
