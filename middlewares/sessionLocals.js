const Cart = require("../models/order/cartModel");
const Wishlist = require("../models/user/wishlistModel");
const Variant = require("../models/product/variantModel");
const Product = require("../models/product/productModel");
const Category = require("../models/product/categoryModel");

const setUserLocals = async (req, res, next) => {
    res.locals.user = req.session.userId || null;

    if (req.session.userId) {
        try {
            const [cart, wishlist] = await Promise.all([
                Cart.findOne({ userId: req.session.userId }).lean(),
                Wishlist.findOne({ userId: req.session.userId }).lean(),
            ]);

            let cartCount = 0;
            if (cart && cart.items && cart.items.length > 0) {
                const variantIds = cart.items.map((i) => i.variantId);
                const variants = await Variant.find({ _id: { $in: variantIds }, isActive: true }).select("_id productId").lean();
                const productIds = variants.map((v) => v.productId);
                const activeProducts = await Product.find({ _id: { $in: productIds }, isDeleted: false, status: "ACTIVE" }).select("_id categoryId").lean();
                const categoryIds = activeProducts.map((p) => p.categoryId);
                const activeCategories = await Category.find({ _id: { $in: categoryIds }, isDeleted: false, isActive: true }).select("_id").lean();

                const activeCategorySet = new Set(activeCategories.map((c) => c._id.toString()));
                const activeProductSet = new Set(
                    activeProducts
                        .filter((p) => activeCategorySet.has(p.categoryId.toString()))
                        .map((p) => p._id.toString())
                );
                const validVariantSet = new Set(
                    variants
                        .filter((v) => activeProductSet.has(v.productId.toString()))
                        .map((v) => v._id.toString())
                );

                const unlistedVariantIds = [];
                for (const item of cart.items) {
                    if (validVariantSet.has(item.variantId.toString())) {
                        cartCount += (item.quantity || 0);
                    } else {
                        unlistedVariantIds.push(item.variantId);
                    }
                }

                if (unlistedVariantIds.length > 0) {
                    Cart.updateOne(
                        { userId: req.session.userId },
                        { $pull: { items: { variantId: { $in: unlistedVariantIds } } } }
                    ).catch((err) => console.error("Error purging unlisted cart items:", err));
                }
            }

            const wishlistCount = wishlist ? (wishlist.items || []).length : 0;

            res.locals.cartCount = cartCount;
            res.locals.wishlistCount = wishlistCount;
        } catch (err) {
            // Non-fatal — degrade gracefully
            res.locals.cartCount = 0;
            res.locals.wishlistCount = 0;
        }
    } else {
        res.locals.cartCount = 0;
        res.locals.wishlistCount = 0;
    }

    next();
};

const setAdminLocals = (req, res, next) => {
    res.locals.admin = req.session.adminId || null;
    next();
};

module.exports = {
    setUserLocals,
    setAdminLocals
};
