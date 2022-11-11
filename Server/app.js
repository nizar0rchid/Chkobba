var createError = require('http-errors');
var io = require('socket.io-client');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var ws = require('ws');
var fs = require('fs');
var crypto = require('crypto');
var http = require('http');
var settings = require("./settings.js");

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));


var server = http.createServer();
var wss = new ws.Server({ port: 8080 });

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render('error');
});



//loading games informations and classes
var games = {
    classic: null,
    cirulla: null,
    cucita: null,
    rebello: null,
    scopone: null
};
var gameClasses = {};
for (var key in games) {
    gameClasses[key] = require(`./js/${key}.js`).GameClass;
    var match = new gameClasses[key]();
    var info = match.send({ "command": "info" }).infos[0];

    games[key] = {
        "name": info.name,
        "number_of_players": info.number_of_players
    };
}

var players = {};
var sockets = {};
var matches = [];


//load the players list saved on the server
fs.readFile(settings.playersFile, { flag: "r" }, function(err, data) {
    if (err) {
        console.log(err);
        //try to create a new json file
        fs.writeFile(settings.playersFile, JSON.stringify(players), function(err, data) {
            if (err) throw err;
        });
    } else {
        players = JSON.parse(data);
        for (var key in players) {
            sockets[key] = {
                socket: null,
                status: "offline"
            }
        }
    }
});

//return the username of the player who opened the socket
function playerFromSocket(socket) {
    for (var player in sockets)
        if (sockets[player].socket === socket)
            return player;

    return null;
}

//return the index of the match that socket is playing
function matchIndexFromSocket(socket) {
    for (var i = 0; i < matches.length; i++)
        for (var j = 0; j < matches[i].sockets.length; j++)
            if (matches[i].sockets[j] === socket)
                return i;

    return null;
}

//return an Array of all players and thier status
function playersList() {
    var array = []
    for (var player in sockets) {
        array.push({
            username: player,
            status: sockets[player].status
        })
    }
    return array;
}

//send players list to every active socket
function broadcastPlayersList() {
    var players = playersList();
    for (var key in sockets) {
        if (sockets[key].socket)
            sockets[key].socket.send(JSON.stringify({
                control: "players",
                data: players
            }));
    }
}

//sends match_data messages to sockets
function sendMatchData(match_data, skts) {
    var msg = JSON.stringify({
        control: "match_data",
        data: match_data
    });

    for (var i = 0; i < skts.length; i++) {
        if (match_data.moves.length > 0) {
            var player = playerFromSocket(skts[i]);
            var hiddenMsg = JSON.parse(msg);
            for (var j in hiddenMsg.data.moves)
            //hide cards for other players
                if (!(hiddenMsg.data.moves[j].visible ||
                        hiddenMsg.data.moves[j].visible_to === player))
                    for (var k in hiddenMsg.data.moves[j].cards) {
                        hiddenMsg.data.moves[j].cards[k].suit = 0;
                        hiddenMsg.data.moves[j].cards[k].value = 0;
                    }
            skts[i].send(JSON.stringify(hiddenMsg));
        } else
            skts[i].send(msg);
    }

}

//continue match until a waiting or winner message
function matchNext(i) {
    var match_data = matches[i].match.send({ command: "next" });
    sendMatchData(match_data, matches[i].sockets);

    for (var j = 0; j < match_data.infos.length; j++) {
        if (match_data.infos[j].info === "waiting")
            return;
        if (match_data.infos[j].info === "winner") {
            //delete match and send match_end message to players            
            for (var j = 0; j < matches[i].sockets.length; j++) {
                matches[i].sockets[j].send(JSON.stringify({
                    control: "match_end",
                    data: null
                }));

                sockets[playerFromSocket(matches[i].sockets[j])].status = "available";
            }

            matches[i] = undefined;

            broadcastPlayersList();

            return;
        }
    }

    matchNext(i);
}

function analyzeMessage(socket, message) {
    var msg = JSON.parse(message);
    console.log(msg);

    if (msg.control === "register") {
        //check if the desired username is available

        if (players[msg.data.username]) {
            socket.send(JSON.stringify({ control: "username_unavailable", data: msg.data.username }));
            return;
        }

        //save the player informations on server (executed only if username is available)
        var hash = crypto.createHash("sha256");
        hash.update(msg.data.password);

        players[msg.data.username] = {
            password: hash.digest("hex")
        };
        sockets[msg.data.username] = {
            socket: null,
            status: "offline"
        };

        fs.writeFile(settings.playersFile, JSON.stringify(players, null, " "), function(err, data) {
            if (err) throw err;
        });

        socket.send(JSON.stringify({ control: "registered", data: msg.data.username }));

        return;
    }

    if (msg.control === "login") {
        //check if the user exists and if password is correct
        if (players[msg.data.username]) {
            var hash = crypto.createHash("sha256");
            hash.update(msg.data.password);
            if (hash.digest("hex") === players[msg.data.username].password) {
                socket.send(JSON.stringify({
                    control: "logged_in",
                    data: {
                        username: msg.data.username,
                        games: games
                    }
                }));
                sockets[msg.data.username] = {
                    socket: socket,
                    status: "available"
                };
                broadcastPlayersList();
            } else
                socket.send(JSON.stringify({ control: "wrong_password", data: msg.data.username }));
            return;
        }
        socket.send(JSON.stringify({ control: "unknown_username", data: msg.data.username }));
        return;
    }

    if (msg.control === "new_match") {
        var issuer = playerFromSocket(socket);
        sockets[issuer].status = "busy";

        //check if the desired players are available
        var availableSockets = [];
        for (var i = 0; i < msg.data.teams.length; i++) {
            for (var j = 0; j < msg.data.teams[i].length; j++) {
                if (msg.data.teams[i][j].type === "human") {
                    if (msg.data.teams[i][j].name !== issuer) {
                        if (sockets[msg.data.teams[i][j].name].status === "available")
                            availableSockets.push(sockets[msg.data.teams[i][j].name].socket);
                        else {
                            //if one player is not available the match negotiation fails
                            socket.send(JSON.stringify({ control: "player_refused", data: msg.data.teams[i][j].name }));
                            return;
                        }
                    }
                }
            }
        }

        //send match proposal to other players if they are all available
        for (var i = 0; i < availableSockets.length; i++) {
            availableSockets[i].send(JSON.stringify({
                control: "match_proposal",
                data: msg.data
            }));

            sockets[playerFromSocket(availableSockets[i])].status = "busy";
        }

        broadcastPlayersList();

        //save match
        availableSockets.push(socket);
        var i = 0;
        while (matches[i] !== undefined) i++;

        matches[i] = {
            request: msg.data,
            match: null,
            sockets: availableSockets,
            acks: [1, availableSockets.length]
        };
        return;
    }

    if (msg.control === "match_proposal") {
        i = matchIndexFromSocket(socket);

        if (msg.data === "accept") {
            matches[i].acks[0] += 1;
            if (matches[i].acks[0] === matches[i].acks[1]) {
                var sendingMsg = JSON.stringify({
                    control: "match_started",
                    data: null
                });
                for (var j = 0; j < matches[i].sockets.length; j++)
                    matches[i].sockets[j].send(sendingMsg);

                var match = new gameClasses[matches[i].request.game]();
                matches[i].match = match;
                var match_data = match.send({
                    command: "start",
                    data: matches[i].request.teams
                });
                sendMatchData(match_data, matches[i].sockets);

                matchNext(i);
            }
        }

        if (msg.data === "refuse") {
            var sendingMsg = JSON.stringify({
                control: "player_refused",
                data: playerFromSocket(socket)
            });
            for (var j = 0; j < matches[i].sockets.length; j++) {
                sockets[playerFromSocket(matches[i].sockets[j])].status = "available";
                if (matches[i].sockets[j] !== socket)
                    matches[i].sockets[j].send(sendingMsg);
            }

            broadcastPlayersList();

            //remove match
            matches[i] = undefined;
        }
        return;
    }

    if (msg.control === "match_data") {
        var i = matchIndexFromSocket(socket);
        var match_data = matches[i].match.send(msg.data);
        sendMatchData(match_data, matches[i].sockets);

        matchNext(i);
        return;
    }

    if (msg.control === "chat") {
        var date = new Date();
        var i = matchIndexFromSocket(socket);
        for (var j = 0; j < matches[i].sockets.length; j++) {
            matches[i].sockets[j].send(JSON.stringify({
                player: playerFromSocket(socket),
                message: msg.data,
                date: date.toISOString()
            }));
        }
        return;
    }
}

function onConnectionClose(socket) {
    //end and delete match of socket and make other players available
    var i = matchIndexFromSocket(socket);
    if (i) {
        for (var j = 0; j < matches[i].sockets.length; j++) {
            if (matches[i].sockets[j] !== socket &&
                matches[i].sockets[j].readyState === matches[i].sockets[j].OPEN) {
                matches[i].sockets[j].send(JSON.stringify({
                    control: "match_end",
                    data: null
                }));

                sockets[playerFromSocket(matches[i].sockets[j])].status = "available";
            }
        }
    }

    var player = playerFromSocket(socket);
    if (player) {
        sockets[player] = {
            socket: null,
            status: "offline"
        };
    }

    broadcastPlayersList();

    return;
}

wss.on('connection', function(socket) {
    console.log("new client connected");
    socket.on('message', function(message) {
        analyzeMessage(socket, message);

    });
    socket.on('close', function(message) {

        onConnectionClose(socket);

    });
});
server.on('request', app);
server.listen(settings.port, settings.host);

/*
//test connection to the server
var connection = new ws('ws://127.0.0.1:8080');

//send test message
connection.onopen = function() {
    connection.send(JSON.stringify({ control: "start", data: { username: "test", password: "test" } }));
    
    connection.close();
};
*/

module.exports = app;