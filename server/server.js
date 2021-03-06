const express = require("express");
const app = express();
const compression = require("compression");
const db = require("./db");
const { compare, hash } = require("./bc");
const cookieSession = require("cookie-session");
const cryptoRandomString = require("crypto-random-string");
const s3 = require("./s3.js");
const multer = require("multer");
const uidSafe = require("uid-safe");
const path = require("path");
const ses = require("./ses.js");
// const { datum } = require("./datum");

const server = require("http").Server(app);
const io = require("socket.io")(server, {
    allowRequest: (req, callback) =>
        callback(null, req.headers.referer.startsWith("http://localhost:3000")),
});

//---------------------------------------------------------------------------------

const diskStorage = multer.diskStorage({
    destination: function (req, file, callback) {
        callback(null, __dirname + "/uploads");
    },
    filename: function (req, file, callback) {
        uidSafe(24).then(function (uid) {
            callback(null, uid + path.extname(file.originalname));
        });
    },
});

const uploader = multer({
    storage: diskStorage,
    limits: {
        fileSize: 2097152,
    },
});
//---------------------------------------------------------------------------------
let sessionSecret;
if (process.env.NODE_ENV == "production") {
    sessionSecret = process.env.SESSION_SECRET;
} else {
    sessionSecret = require("../secrets.json").SESSION_SECRET;
}
//---------------------------------------------------------------------------------
app.use(
    cookieSession({
        secret: `${sessionSecret}`,
        maxAge: 1000 * 60 * 60 * 24 * 14,
        sameSite: true,
    })
);

const cookieSessionMiddleware = cookieSession({
    secret: `I'm always angry.`,
    maxAge: 1000 * 60 * 60 * 24 * 90,
});

app.use(cookieSessionMiddleware);
io.use(function (socket, next) {
    cookieSessionMiddleware(socket.request, socket.request.res, next);
});

app.use(compression());

app.use(express.static(path.join(__dirname, "..", "client", "public")));

app.use(express.json());

app.get("/user/id.json", function (req, res) {
    res.json({
        userId: req.session.userId,
    });
});
//-----------------------------register--------------------------------------------
app.post("/register", (req, res) => {
    const { first, last, email, password } = req.body;

    hash(password)
        .then((hashedPass) => {
            db.register(first, last, email, hashedPass)
                .then((data) => {
                    req.session.userId = data.rows[0].id;
                    res.json({ success: true });
                })
                .catch((err) => {
                    console.log("error in POST /register in db.register", err);
                    res.json({ error: true });
                });
        })
        .catch((err) => {
            console.log("error in POST /register in hash", err);
            res.json({ error: true });
        });
});
//----------------------------login-------------------------------------------------
app.post("/login", (req, res) => {
    const { email, password } = req.body;
    db.getLoginInfo(email)
        .then((data) => {
            compare(password, data.rows[0].hashed_password)
                .then((match) => {
                    if (match === true) {
                        req.session.userId = data.rows[0].id;
                        res.json({ success: true });
                        return;
                    } else {
                        res.json({ success: false });
                        return;
                    }
                })
                .catch((err) => {
                    console.log("error in compare:", err);
                    res.json({ error: true });
                });
        })
        .catch((err) => {
            console.log("error in getLoginInfo:", err);
            res.json({ error: true });
        });
});
//-----------------------------password-reset--------------------------------------
app.post("/password/reset/start", (req, res) => {
    const { email } = req.body;
    db.getLoginInfo(email).then((data) => {
        if (data.rows[0].email) {
            const secretCode = cryptoRandomString({
                length: 6,
            });
            const emailToUser = `Please use this code to rest the  password for your account.
                Here is your code: ${secretCode}
                This code will expire in 10 minutes!`;
            db.storeRestCode(email, secretCode)
                .then(
                    ses
                        .sendEmail(email, secretCode, emailToUser)
                        .then(res.json({ success: true }))
                        .catch((err) => {
                            console.log("error in sending an email: ", err);
                            res.json({ error: true });
                            return;
                        })
                )
                .catch((err) => {
                    console.log(
                        "error in getting login info in /password/reset/start: ",
                        err
                    );
                });
        } else {
            res.json({
                success: false,
                error: "Somthing went wrong! Please try again.",
            });
            return;
        }
    });
});

//-----------------------password-verify---------------------------------------------
app.post("/password/reset/verify", (req, res) => {
    db.verifyCode(req.body.email)
        .then(() => {
            hash(req.body.password)
                .then((hashedPass) => {
                    db.resetPassword(req.body.email, hashedPass)
                        .then(() => {
                            res.json({ success: true });
                            return;
                        })
                        .catch((err) => {
                            console.log(
                                "error in db.resetPassword POST/verfiy: ",
                                err
                            );
                            res.json({ success: false });
                            return;
                        });
                })
                .catch((err) => {
                    console.log("error in hashedPass POST/verify: ", err);
                    res.json({ success: false });
                    return;
                });
        })
        .catch((err) => {
            console.log("error in db.verifyCode POST/verify: ", err);
            res.json({ success: false });
        });
});

//------------------GET user----------------------------------------------------------
app.get("/user", (req, res) => {
    db.getUser(req.session.userId)
        .then((data) => {
            res.json(data.rows[0]);
        })
        .catch((err) => {
            console.log("error in db.getUser /user: ", err);
            res.json({ success: false });
        });
});
//--------------------------------------
app.get("/api/user/:id", (req, res) => {
    const requestedId = req.params.id;

    db.getOtherUser(requestedId)
        .then(({ rows }) => {
            rows[0].requestingId = req.session.userId;
            res.json({ rows });
        })
        .catch((err) => {
            console.log("err in /user/:id db.getOtherUser ", err);
            res.json({ success: false });
        });
});

//------------------------Uploader-----------------------------------------------------
app.post("/upload", uploader.single("file"), s3.upload, (req, res) => {
    const url = `https://s3.amazonaws.com/spicedling/${req.file.filename}`;
    db.addProfilePic(url, req.session.userId)
        .then(() => {
            res.json({ success: true, imageurl: url });
        })
        .catch((err) => {
            console.log("error in db.addProfilePic /upload:", err);
            res.json({ success: false });
        });
});

//--------------------------ADD BIO------------------------------------------------------
app.post("/updateBio", (req, res) => {
    const { bio } = req.body;
    db.addBio(bio, req.session.userId)
        .then(({ rows }) => {
            res.json({ rows, bio });
        })
        .catch((err) => {
            console.log("err in /updateBio db.addBio :>> ", err);
            res.json({ success: false });
        });
});
//----------------------Find People-------------------------------------------------------
app.get("/api/findPeople/:name", async (req, res) => {
    if (req.params.name === "name") {
        try {
            const { rows } = await db.getRecentUsers();
            res.json(rows);
        } catch (err) {
            console.log("error in /findPeople db.getRecentUsers: ", err);
            res.json({ success: false });
        }
    } else {
        try {
            const { rows } = await db.getMatchingUsers(req.params.name);
            res.json(rows);
        } catch (err) {
            console.log(
                "error in /findPeople/:name db.getMatchingusers: ",
                err
            );
            res.json({ success: false });
        }
    }
});
//------------------------------Friendship---------------------------------------------------
app.get("/checkFriendStatus/:id", async (req, res) => {
    const userId = req.session.userId;
    const otherUserId = req.params.id;

    try {
        const { rows } = await db.checkFriendStatus(userId, otherUserId);
        if (!rows.length) {
            res.json({ buttonText: "Send Friend Request" });
        } else if (rows[0].accepted) {
            res.json({ buttonText: "End Friendship / Unfriend" });
        } else if (!rows[0].accepted) {
            if (rows[0].sender_id == userId) {
                res.json({ buttonText: "Cancel Friend Request" });
            } else {
                res.json({ buttonText: "Accept Friend Request" });
            }
        }
    } catch (err) {
        console.log("error in /checkFriendStatus db.checkFriendStatus: ", err);
        res.json({ success: false });
    }
});
//----------------------
app.post("/friendship/:id", async (req, res) => {
    const buttonStatus = req.body.buttonText;
    const userId = req.session.userId;
    const otherUserId = req.params.id;

    if (buttonStatus === "Send Friend Request") {
        try {
            const data = await db.sendFriendRequest(userId, otherUserId);
            res.json({
                otherUserId: data.recipient_id,
                buttonText: "Cancel Friend Request",
            });
        } catch (err) {
            console.log("error in db.sendFriendRequest: ", err);
        }
    } else if (buttonStatus === "Accept Friend Request") {
        try {
            const data = await db.acceptFriendRequest(userId, otherUserId);
            res.json({
                otherUserId: data.recipient_id,
                buttonText: "End Friendship / Unfriend",
            });
        } catch (err) {
            console.log("error in db.acceptFriendRequest: ", err);
        }
    } else if (
        buttonStatus === "End Friendship / Unfriend" ||
        buttonStatus === "Cancel Friend Request"
    ) {
        try {
            const data = await db.cancel_deleteFriendRequest(
                userId,
                otherUserId
            );
            res.json({
                otherUserId: data.recipient_id,
                buttonText: "Send Friend Request",
            });
        } catch (err) {
            console.log("error in db.cancel_deleteFriendRequest: ", err);
        }
    }
});

//---------------------------------------------------------------------------------
app.get("/friends-and-wanabees", async (req, res) => {
    const { rows } = await db
        .friendsAndWannabees(req.session.userId)
        .catch((err) => {
            console.log("error in db.getFriendsList: ", err);
            res.json({ success: false });
        });
    res.json(rows);
});
//---------------------------------------------------------------------------------


//---------------------------------------------------------------------------------
app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/register");
    return;
});

//-------------------------------------------------------------
app.get("*", function (req, res) {
    res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

server.listen(process.env.PORT || 3001, function () {
    console.log("I'm listening on port 3001.");
});
//=======================================================================socket========================================================================================

io.on("connection", async (socket) => {
    console.log(`the socket with id: ${socket.id} connected!`);
    // console.log("socket.request.session: ", socket.request.session);

    const userId = socket.request.session.userId;
    if (!userId) {
        return socket.disconnect(true);
    }

    const { rows } = await db
        .getLast10Messages()
        .catch((err) => console.log("error in db.get10msg: ", err));

    socket.emit("Last10Messages", rows.reverse());

    socket.on("newMesage", async (message) => {
        try {
            await db.addMessage(userId, message);
            const { rows } = await db.getLast10Messages();
            io.emit("Last10Messages", rows.reverse());
        } catch (err) {
            console.log("error in db.addMessage: ", err);
        }
    });

    socket.on("disconnect", () => {
        console.log(`the socket with id: ${socket.id} disconnect!`);
    });
});
