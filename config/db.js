const mongoose = require("mongoose");

const runStartupMigrations = async () => {
    try {
        const db = mongoose.connection.db;
        if (!db) return;
        const legacyOrders = await db
            .collection("orders")
            .find({
                $or: [
                    { orderId: { $exists: false } },
                    { orderId: null },
                    { orderId: "" },
                    { checkoutToken: { $exists: false } },
                    { checkoutToken: null },
                    { checkoutToken: "" },
                ],
            })
            .toArray();

        for (const doc of legacyOrders) {
            const updates = {};
            if (!doc.orderId) {
                updates.orderId = doc.orderNumber || doc.orderID || `VEL-${doc._id.toString().toUpperCase()}`;
            }
            if (!doc.checkoutToken) {
                updates.checkoutToken = `chk_legacy_${doc._id.toString()}`;
            }
            if (Object.keys(updates).length > 0) {
                await db.collection("orders").updateOne(
                    { _id: doc._id },
                    { $set: updates }
                );
            }
        }
    } catch (err) {
        console.error("Startup migration warning:", err.message);
    }
};

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected");
        await runStartupMigrations();
    } catch (error) {
        console.log("MongoDB Connection Failed");
        console.error(error.message);
        process.exit(1);
    }
};

module.exports = connectDB;