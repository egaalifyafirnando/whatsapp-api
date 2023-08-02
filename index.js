const {
    default: makeWASocket,
    MessageType,
    MessageOptions,
    Mimetype,
    DisconnectReason,
    BufferJSON,
    AnyMessageContent,
    delay,
    fetchLatestBaileysVersion,
    isJidBroadcast,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    MessageRetryMap,
    useMultiFileAuthState,
    msgRetryCounterMap,
} = require('@adiwajshing/baileys');

const log = (pino = require('pino'));
const { session } = { session: 'baileys_auth_info' };
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = require('express')();

app.use(
    fileUpload({
        createParentPath: true,
    })
);
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const server = require('http').createServer(app);
const io = require('socket.io')(server);
const port = process.env.PORT || 3001;
const qrcode = require('qrcode');

app.use('/assets', express.static(__dirname + '/client/assets'));

app.get('/scan', (req, res) => {
    res.sendFile('./client/server.html', {
        root: __dirname,
    });
});

app.get('/', (req, res) => {
    res.sendFile('./client/index.html', {
        root: __dirname,
    });
});

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

let sock;
let qr;
let soket;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    let { version, isLatest } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger: log({ level: 'silent' }),
        version: [2, 2323, 4],
        shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    });
    store.bind(sock.ev);
    sock.multi = true;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            let reason = new Boom(lastDisconnect.error).output.statusCode;
            if (reason === DisconnectReason.badSession) {
                console.log(`Bad Session File, Please Delete ${session} and Scan Again`);
                // sock.logout();
                connectToWhatsApp();
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log('Connection closed, reconnecting....');
                connectToWhatsApp();
            } else if (reason === DisconnectReason.connectionLost) {
                console.log('Connection Lost from Server, reconnecting...');
                connectToWhatsApp();
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log('Connection Replaced, Another New Session Opened, Please Close Current Session First');
                sock.logout();
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(`Device Logged Out, Please Delete ${session} and Scan Again.`);
                // sock.logout();
                connectToWhatsApp();
            } else if (reason === DisconnectReason.restartRequired) {
                console.log('Restart Required, Restarting...');
                connectToWhatsApp();
            } else if (reason === DisconnectReason.timedOut) {
                console.log('Connection TimedOut, Reconnecting...');
                connectToWhatsApp();
            } else {
                sock.end(`Unknown DisconnectReason: ${reason}|${lastDisconnect.error}`);
            }
        } else if (connection === 'open') {
            console.log('opened connection');
            // let groups = Object.values(await sock.groupFetchAllParticipating());
            // for (let group of groups) {
            //     console.log('Group ID: ' + group.id + ' || Nama Group: ' + group.subject);
            // }
            return;
        }

        if (update.qr) {
            qr = update.qr;
            updateQR('qr');
        } else if ((qr = undefined)) {
            updateQR('loading');
        } else {
            if (update.connection === 'open') {
                updateQR('qrscanned');
                return;
            }
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

io.on('connection', async (socket) => {
    soket = socket;
    if (isConnected) {
        updateQR('connected');
    } else if (qr) {
        updateQR('qr');
    }
});

// functions
const isConnected = () => {
    return sock.user;
};

const updateQR = (data) => {
    switch (data) {
        case 'qr':
            qrcode.toDataURL(qr, (err, url) => {
                soket?.emit('qr', url);
                soket?.emit('log', 'QR Code received, please scan!');
            });
            break;
        case 'connected':
            soket?.emit('qrstatus', './assets/check.svg');
            soket?.emit('log', 'WhatsApp terhubung!');
            break;
        case 'qrscanned':
            soket?.emit('qrstatus', './assets/check.svg');
            soket?.emit('log', 'QR Code Telah discan!');
            break;
        case 'loading':
            soket?.emit('qrstatus', './assets/loader.gif');
            soket?.emit('log', 'Registering QR Code , please wait!');
            break;
        default:
            break;
    }
};

// send text message to wa user
app.post('/send-message', async (req, res) => {
    const reqMessage = req.body.message;
    const reqPhone = req.body.phone;
    let whatsAppNumber;

    try {
        if (!req.files) {
            if (reqMessage == undefined) {
                res.status(500).json({
                    status: false,
                    response: 'Body pesan belum disertakan!',
                });
            } else if (!reqPhone) {
                res.status(500).json({
                    status: false,
                    response: 'Nomor WA belum tidak disertakan!',
                });
            } else {
                whatsAppNumber = '62' + reqPhone.substring(1) + '@s.whatsapp.net';
                console.log(await sock.onWhatsApp(whatsAppNumber));
                if (isConnected) {
                    const exists = await sock.onWhatsApp(whatsAppNumber);
                    if (exists?.jid || (exists && exists[0]?.jid)) {
                        sock.sendMessage(exists.jid || exists[0].jid, { text: reqMessage })
                            .then((result) => {
                                res.status(200).json({
                                    status: true,
                                    response: result,
                                });
                            })
                            .catch((err) => {
                                res.status(500).json({
                                    status: false,
                                    response: err,
                                });
                            });
                    } else {
                        res.status(500).json({
                            status: false,
                            response: `Nomor ${reqPhone} tidak terdaftar.`,
                        });
                    }
                } else {
                    res.status(500).json({
                        status: false,
                        response: `WhatsApp belum terhubung.`,
                    });
                }
            }
        } else {
            if (!reqPhone) {
                res.status(500).json({
                    status: false,
                    response: 'Nomor WA belum tidak disertakan!',
                });
            } else {
                whatsAppNumber = '62' + reqPhone.substring(1) + '@s.whatsapp.net';
                let reqFile = req.files.file;
                var changeFileName = new Date().getTime() + '_' + reqFile.name;
                reqFile.mv('./uploads/' + changeFileName);
                let reqFileMime = reqFile.mimetype;

                if (isConnected) {
                    const exists = await sock.onWhatsApp(whatsAppNumber);

                    if (exists?.jid || (exists && exists[0]?.jid)) {
                        let fileName = './uploads/' + changeFileName;
                        let extensionName = path.extname(fileName);
                        if (
                            extensionName === '.jpeg' ||
                            extensionName === '.jpg' ||
                            extensionName === '.png' ||
                            extensionName === '.gif'
                        ) {
                            await sock
                                .sendMessage(exists.jid || exists[0].jid, {
                                    image: {
                                        url: fileName,
                                    },
                                    caption: reqMessage,
                                })
                                .then((result) => {
                                    if (fs.existsSync(fileName)) {
                                        fs.unlink(fileName, (err) => {
                                            if (err && err.code == 'ENOENT') {
                                                // file doens't exist
                                                console.info("File doesn't exist, won't remove it.");
                                            } else if (err) {
                                                console.error('Error occurred while trying to remove file.');
                                            }
                                            //console.log('File deleted!');
                                        });
                                    }
                                    res.send({
                                        status: true,
                                        message: 'Success',
                                        data: {
                                            name: reqFile.name,
                                            mimetype: reqFile.mimetype,
                                            size: reqFile.size,
                                        },
                                    });
                                })
                                .catch((err) => {
                                    res.status(500).json({
                                        status: false,
                                        response: err,
                                    });
                                    console.log('pesan gagal terkirim');
                                });
                        } else if (extensionName === '.mp3' || extensionName === '.ogg') {
                            await sock
                                .sendMessage(exists.jid || exists[0].jid, {
                                    audio: {
                                        url: fileName,
                                        caption: reqMessage,
                                    },
                                    mimetype: 'audio/mp4',
                                })
                                .then((result) => {
                                    if (fs.existsSync(fileName)) {
                                        fs.unlink(fileName, (err) => {
                                            if (err && err.code == 'ENOENT') {
                                                // file doens't exist
                                                console.info("File doesn't exist, won't remove it.");
                                            } else if (err) {
                                                console.error('Error occurred while trying to remove file.');
                                            }
                                            //console.log('File deleted!');
                                        });
                                    }
                                    res.send({
                                        status: true,
                                        message: 'Success',
                                        data: {
                                            name: reqFile.name,
                                            mimetype: reqFile.mimetype,
                                            size: reqFile.size,
                                        },
                                    });
                                })
                                .catch((err) => {
                                    res.status(500).json({
                                        status: false,
                                        response: err,
                                    });
                                    console.log('pesan gagal terkirim');
                                });
                        } else {
                            await sock
                                .sendMessage(exists.jid || exists[0].jid, {
                                    document: {
                                        url: fileName,
                                        caption: reqMessage,
                                    },
                                    mimetype: reqFileMime,
                                    changeFileName: reqFile.name,
                                })
                                .then((result) => {
                                    if (fs.existsSync(fileName)) {
                                        fs.unlink(fileName, (err) => {
                                            if (err && err.code == 'ENOENT') {
                                                // file doens't exist
                                                console.info("File doesn't exist, won't remove it.");
                                            } else if (err) {
                                                console.error('Error occurred while trying to remove file.');
                                            }
                                            //console.log('File deleted!');
                                        });
                                    }

                                    res.send({
                                        status: true,
                                        message: 'Success',
                                        data: {
                                            name: reqFile.name,
                                            mimetype: reqFile.mimetype,
                                            size: reqFile.size,
                                        },
                                    });
                                })
                                .catch((err) => {
                                    res.status(500).json({
                                        status: false,
                                        response: err,
                                    });
                                    console.log('pesan gagal terkirim');
                                });
                        }
                    } else {
                        res.status(500).json({
                            status: false,
                            response: `Nomor ${reqPhone} tidak terdaftar.`,
                        });
                    }
                } else {
                    res.status(500).json({
                        status: false,
                        response: `WhatsApp belum terhubung.`,
                    });
                }
            }
        }
    } catch (err) {
        res.status(500).send(err);
    }
});

// send group message
app.post('/send-group-message', async (req, res) => {
    const reqMessage = req.body.message;
    const reqGroupId = req.body.group_id;
    let whatsAppGroup;

    try {
        if (isConnected) {
            if (!req.files) {
                if (reqMessage == undefined) {
                    res.status(500).json({
                        status: false,
                        response: 'Body pesan belum disertakan!',
                    });
                } else if (!reqGroupId) {
                    res.status(500).json({
                        status: false,
                        response: 'Nomor Id Group belum disertakan!',
                    });
                } else {
                    let whatsAppGroup = await sock.groupMetadata(reqGroupId);
                    console.log(whatsAppGroup.id);
                    console.log('isConnected');
                    if (whatsAppGroup?.id || (whatsAppGroup && whatsAppGroup[0]?.id)) {
                        sock.sendMessage(reqGroupId, { text: reqMessage })
                            .then((result) => {
                                res.status(200).json({
                                    status: true,
                                    response: result,
                                });
                                console.log('succes terkirim');
                            })
                            .catch((err) => {
                                res.status(500).json({
                                    status: false,
                                    response: err,
                                });
                                console.log('error 500');
                            });
                    } else {
                        res.status(500).json({
                            status: false,
                            response: `ID Group ${reqGroupId} tidak terdaftar.`,
                        });
                        console.log(`ID Group ${reqGroupId} tidak terdaftar.`);
                    }
                }
            } else {
                //console.log('Kirim document');
                if (!reqGroupId) {
                    res.status(500).json({
                        status: false,
                        response: 'Id Group tidak disertakan!',
                    });
                } else {
                    whatsAppGroup = await sock.groupMetadata(reqGroupId);
                    console.log(whatsAppGroup.id);

                    let reqFile = req.files.file;
                    var changeFileName = new Date().getTime() + '_' + reqFile.name;
                    //pindahkan file ke dalam upload directory
                    reqFile.mv('./uploads/' + changeFileName);
                    let reqFileMime = reqFile.mimetype;
                    //console.log('Simpan document '+reqFileMime);
                    if (isConnected) {
                        if (whatsAppGroup?.id || (whatsAppGroup && whatsAppGroup[0]?.id)) {
                            let fileName = './uploads/' + changeFileName;
                            let extensionName = path.extname(fileName);
                            if (
                                extensionName === '.jpeg' ||
                                extensionName === '.jpg' ||
                                extensionName === '.png' ||
                                extensionName === '.gif'
                            ) {
                                await sock
                                    .sendMessage(whatsAppGroup.id || whatsAppGroup[0].id, {
                                        image: {
                                            url: fileName,
                                        },
                                        caption: reqMessage,
                                    })
                                    .then((result) => {
                                        if (fs.existsSync(fileName)) {
                                            fs.unlink(fileName, (err) => {
                                                if (err && err.code == 'ENOENT') {
                                                    // file doens't exist
                                                    console.info("File doesn't exist, won't remove it.");
                                                } else if (err) {
                                                    console.error('Error occurred while trying to remove file.');
                                                }
                                                //console.log('File deleted!');
                                            });
                                        }
                                        res.send({
                                            status: true,
                                            message: 'Success',
                                            data: {
                                                name: reqFile.name,
                                                mimetype: reqFile.mimetype,
                                                size: reqFile.size,
                                            },
                                        });
                                    })
                                    .catch((err) => {
                                        res.status(500).json({
                                            status: false,
                                            response: err,
                                        });
                                        console.log('pesan gagal terkirim');
                                    });
                            } else if (extensionName === '.mp3' || extensionName === '.ogg') {
                                await sock
                                    .sendMessage(whatsAppGroup.id || whatsAppGroup[0].id, {
                                        audio: {
                                            url: fileName,
                                            caption: reqMessage,
                                        },
                                        mimetype: 'audio/mp4',
                                    })
                                    .then((result) => {
                                        if (fs.existsSync(fileName)) {
                                            fs.unlink(fileName, (err) => {
                                                if (err && err.code == 'ENOENT') {
                                                    // file doens't exist
                                                    console.info("File doesn't exist, won't remove it.");
                                                } else if (err) {
                                                    console.error('Error occurred while trying to remove file.');
                                                }
                                                //console.log('File deleted!');
                                            });
                                        }
                                        res.send({
                                            status: true,
                                            message: 'Success',
                                            data: {
                                                name: reqFile.name,
                                                mimetype: reqFile.mimetype,
                                                size: reqFile.size,
                                            },
                                        });
                                    })
                                    .catch((err) => {
                                        res.status(500).json({
                                            status: false,
                                            response: err,
                                        });
                                        console.log('pesan gagal terkirim');
                                    });
                            } else {
                                await sock
                                    .sendMessage(whatsAppGroup.id || whatsAppGroup[0].id, {
                                        document: {
                                            url: fileName,
                                            caption: reqMessage,
                                        },
                                        mimetype: reqFileMime,
                                        fileName: reqFile.name,
                                    })
                                    .then((result) => {
                                        if (fs.existsSync(fileName)) {
                                            fs.unlink(fileName, (err) => {
                                                if (err && err.code == 'ENOENT') {
                                                    // file doens't exist
                                                    console.info("File doesn't exist, won't remove it.");
                                                } else if (err) {
                                                    console.error('Error occurred while trying to remove file.');
                                                }
                                                //console.log('File deleted!');
                                            });
                                        }

                                        setTimeout(() => {
                                            sock.sendMessage(whatsAppGroup.id || whatsAppGroup[0].id, {
                                                text: reqMessage,
                                            });
                                        }, 1000);

                                        res.send({
                                            status: true,
                                            message: 'Success',
                                            data: {
                                                name: reqFile.name,
                                                mimetype: reqFile.mimetype,
                                                size: reqFile.size,
                                            },
                                        });
                                    })
                                    .catch((err) => {
                                        res.status(500).json({
                                            status: false,
                                            response: err,
                                        });
                                        console.log('pesan gagal terkirim');
                                    });
                            }
                        } else {
                            res.status(500).json({
                                status: false,
                                response: `Nomor ${number} tidak terdaftar.`,
                            });
                        }
                    } else {
                        res.status(500).json({
                            status: false,
                            response: `WhatsApp belum terhubung.`,
                        });
                    }
                }
            }

            //end is connected
        } else {
            res.status(500).json({
                status: false,
                response: `WhatsApp belum terhubung.`,
            });
        }

        //end try
    } catch (err) {
        res.status(500).send(err);
    }
});

connectToWhatsApp().catch((err) => console.log('unexpected error: ' + err)); // catch any errors
server.listen(port, () => {
    console.log('Server running on Port : ' + port);
});
