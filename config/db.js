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

        const productCollection = db.collection("products");
        if (productCollection) {
            const duplicateSlugGroups = await productCollection
                .aggregate([
                    { $match: { slug: { $exists: true, $ne: null } } },
                    { $group: { _id: "$slug", count: { $sum: 1 }, docs: { $push: { _id: "$_id", name: "$name", slug: "$slug" } } } },
                    { $match: { count: { $gt: 1 } } }
                ])
                .toArray();

            for (const group of duplicateSlugGroups) {

                const docs = group.docs;
                for (let i = 1; i < docs.length; i++) {
                    const doc = docs[i];
                    let counter = i + 1;
                    let newSlug = `${group._id}-${counter}`;
                    while (await productCollection.findOne({ slug: newSlug })) {
                        counter++;
                        newSlug = `${group._id}-${counter}`;
                    }
                    await productCollection.updateOne(
                        { _id: doc._id },
                        { $set: { slug: newSlug } }
                    );
                }
            }

            const missingSlugProducts = await productCollection
                .find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] })
                .toArray();

            for (const doc of missingSlugProducts) {
                const base = (doc.name || "product").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
                let candidate = base;
                let c = 1;
                while (await productCollection.findOne({ slug: candidate })) {
                    c++;
                    candidate = `${base}-${c}`;
                }
                await productCollection.updateOne(
                    { _id: doc._id },
                    { $set: { slug: candidate } }
                );
            }

            try {
                await productCollection.createIndex({ slug: 1 }, { unique: true });
            } catch (idxErr) {
                console.error("Product slug index creation warning:", idxErr.message);
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