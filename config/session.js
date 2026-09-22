const session = require("express-session");
const MongoStore = require("connect-mongo").default;

const store = MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
});

/**
 * Builds a session middleware with its own cookie name. Giving the user
 * side and admin side separate cookies (instead of sharing one) means
 * they are two entirely independent sessions in the same browser — an
 * admin can be logged in on /admin/* while also being logged in as a
 * normal shopper on the storefront, and neither login affects the other.
 */
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
