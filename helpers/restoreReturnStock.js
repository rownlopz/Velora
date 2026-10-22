const Variant = require("../models/product/variantModel");

const restoreReturnStock = async (orderId, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("Invalid quantity for return stock restoration.");
    }

    const key = `RETURN:${orderId}:${item._id}`;

    const result = await Variant.updateOne(
        {
            _id: item.variantId,
            returnRestockKeys: { $ne: key },
        },
        {
            $inc: { stock: item.quantity },
            $addToSet: { returnRestockKeys: key },
        }
    );

    if (result.modifiedCount === 1) {
        return;
    }

    const alreadyRestored = await Variant.exists({
        _id: item.variantId,
        returnRestockKeys: key,
    });

    if (!alreadyRestored) {
        throw new Error(
            "Original variant not found. Return stock could not be restored."
        );
    }
};

module.exports = restoreReturnStock;