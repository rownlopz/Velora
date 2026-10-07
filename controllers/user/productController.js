const { parseListingQuery, listProducts, getListingFilterOptions } = require("../../services/user/productListService");
const { getProductDetail } = require("../../services/user/productDetailService");
const Wishlist = require("../../models/user/wishlistModel");

const loadProducts = async (req, res, next) => {
    try {
        const query = parseListingQuery(req.query);
        const { products, totalProducts, totalPages, currentPage } = await listProducts(query, 12);
        const { categories, priceMin, priceMax, availableSizes, availableColors } = await getListingFilterOptions();

        let wishlistVariantIds = [];
        if (req.session && req.session.userId) {
            const wishlist = await Wishlist.findOne({ userId: req.session.userId }).lean();
            if (wishlist && wishlist.items) {
                wishlistVariantIds = wishlist.items.map(i => i.variantId.toString());
            }
        }

        res.render("user/products", {
            filters: query,
            products,
            totalProducts,
            totalPages,
            currentPage,
            categories,
            priceMin,
            priceMax,
            availableSizes,
            availableColors,
            notice: req.query.notice || null,
            wishlistVariantIds,
        });
    } catch (error) {
        next(error);
    }
};

const loadCategories = async (req, res, next) => {
    try {
        const Category = require("../../models/product/categoryModel");
        const Product = require("../../models/product/productModel");
        
        const categories = await Category.find({ isDeleted: false, isActive: true }).sort({ name: 1 }).lean();
        
        for (const cat of categories) {
            const product = await Product.findOne({ categoryId: cat._id, isDeleted: false, status: "ACTIVE" }).select("thumbnail").lean();
            cat.image = product ? product.thumbnail : "https://res.cloudinary.com/demo/image/upload/v1312461204/sample.jpg";
        }

        res.render("user/categories", { categories });
    } catch (error) {
        next(error);
    }
};

const loadProductDetail = async (req, res) => {
    try {
        const result = await getProductDetail(req.params.slug);

        if (!result.success) {
            // Product not found, unlisted, or category inactive — redirect to shop.
            return res.redirect(`/products?notice=${encodeURIComponent(result.message)}`);
        }

        res.render("user/product-detail", {
            title: result.product.name,
            product: result.product,
            variants: result.variants,
            totalStock: result.totalStock,
            isUnavailable: result.isUnavailable,
            reviews: result.reviews,
            averageRating: result.averageRating,
            totalReviews: result.totalReviews,
            relatedProducts: result.relatedProducts,
        });
    } catch (error) {
        console.error("Load Product Detail Error:", error);
        return res.redirect("/products?notice=" + encodeURIComponent("This product could not be found."));
    }
};

module.exports = {
    loadProducts,
    loadCategories,
    loadProductDetail,
};
