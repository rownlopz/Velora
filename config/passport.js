const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/user/userModel");

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: "https://velora.rowanlopez.in/auth/google/callback",
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const email = profile.emails && profile.emails[0] ? profile.emails[0].value.toLowerCase() : null;

                if (!email) {
                    return done(null, false, { message: "Google account has no email" });
                }

                let user = await User.findOne({ email });

                if (user) {
                    if (user.role !== "USER") {
                        return done(null, false, { message: "This account cannot sign in with Google." });
                    }

                    if (!user.isActive) {
                        return done(null, false, { message: "Your account has been blocked by admin. Please contact support." });
                    }

                    let userChanged = false;

                    if (!user.googleId) {
                        user.googleId = profile.id;
                        user.isEmailVerified = true;
                        userChanged = true;
                    }
                    if (!user.referralId) {
                        let candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
                        while (await User.exists({ referralId: candidateRef })) {
                            candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
                        }
                        user.referralId = candidateRef;
                        userChanged = true;
                    }
                    if (userChanged) {
                        await user.save();
                    }
                    return done(null, user);
                }

                let candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
                while (await User.exists({ referralId: candidateRef })) {
                    candidateRef = "VEL" + Math.random().toString(36).substring(2, 8).toUpperCase();
                }

                user = await User.create({
                    fullName: profile.displayName || "Velora User",
                    email,
                    googleId: profile.id,
                    authProvider: "GOOGLE",
                    isEmailVerified: true,
                    avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : "",
                    role: "USER",
                    isActive: true,
                    referralId: candidateRef,
                });

                return done(null, user);
            } catch (error) {
                return done(error, null);
            }
        }
    )
);

module.exports = passport;
