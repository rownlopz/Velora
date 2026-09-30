const session = require("express-session");
const MongoStore = require("connect-mongo").default;

const store = MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
});

const createSessionMiddleware = (cookieName) =>
    session({
        name: cookieName,
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24, // 1 day
            httpOnly: true,
            secure: false,
        },
    });

const userSessionConfig = createSessionMiddleware("velora.user.sid");
const adminSessionConfig = createSessionMiddleware("velora.admin.sid");

module.exports = { userSessionConfig, adminSessionConfig };
