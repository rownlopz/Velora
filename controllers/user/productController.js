const { parseListingQuery, listProducts, getListingFilterOptions } = require("../../services/user/productListService");
const { getProductDetail } = require("../../services/user/productDetailService");

const loadProducts = async (req, res, next) => {
    try {
        const query = parseListingQuery(req.query);
        const { products, totalProducts, totalPages, currentPage } = await listProducts(query, 12);
        const { categories, priceMin, priceMax, availableSizes, availableColors } = await getListingFilterOptions();

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
            // Covers: not found, invalid slug, deleted, blocked/unlisted,
            // or no purchasable variants. Every case sends the user back
            // to a working listing page rather than a dead end, and this
            // logic re-runs on every request — including a refresh of a
            // product that just became unavailable.
            return res.redirect(`/products?notice=${encodeURIComponent(result.message)}`);
        }

        res.render("user/product-detail", {
            title: result.product.name,
            product: result.product,
            variants: result.variants,
            totalStock: result.totalStock,
            reviews: result.reviews,
            averageRating: result.averageRating,
            totalReviews: result.totalReviews,
            relatedProducts: result.relatedProducts,
        });
    } catch (error) {
        // Includes Mongoose CastError from a malformed slug/id reaching
        // here some other way — never let a bad param 500 the page.
        console.error("Load Product Detail Error:", error);
        return res.redirect("/products?notice=" + encodeURIComponent("This product could not be found."));
    }
};

module.exports = {
    loadProducts,
    loadCategories,
    loadProductDetail,
};
