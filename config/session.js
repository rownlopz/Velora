const session = require("express-session");
const MongoStore = require("connect-mongo").default;

const sessionConfig = session({
    secret: process.env.SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI,
    }),

    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        httpOnly: true,
        secure: false,
    },
});

module.exports = sessionConfig;