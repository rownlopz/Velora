const Variant = require("../models/product/variantModel");

const restoreCancellationStock = async (orderId, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("Invalid quantity for stock restoration.");
    }

    const key = `CANCEL:${orderId}:${item._id}`;

    const result = await Variant.updateOne(
        {
            _id: item.variantId,
            cancellationRestockKeys: { $ne: key },
        },
        {
            $inc: { stock: item.quantity },
            $addToSet: { cancellationRestockKeys: key },
        }
    );

    if (result.modifiedCount === 1) {
        return;
    }

    // A repeated request is safe if this cancellation
    // has already restored the stock.
    const alreadyRestored = await Variant.exists({
        _id: item.variantId,
        cancellationRestockKeys: key,
    });

    if (!alreadyRestored) {
        throw new Error(
            "Original variant not found. Stock could not be restored."
        );
    }
};

module.exports = restoreCancellationStock;