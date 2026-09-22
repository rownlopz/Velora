const { parseListingQuery, listProducts, getListingFilterOptions } = require("../../services/user/productListService");
const { getProductDetail } = require("../../services/user/productDetailService");

const loadProductListing = async (req, res) => {
    try {
        const filters = parseListingQuery(req.query);

        const [listing, filterOptions] = await Promise.all([
            listProducts(filters, 12),
            getListingFilterOptions(),
        ]);

        res.render("user/products", {
            title: "Products",
            products: listing.products,
            totalProducts: listing.totalProducts,
            totalPages: listing.totalPages,
            currentPage: listing.currentPage,
            filters,
            categories: filterOptions.categories,
            priceMin: filterOptions.priceMin,
            priceMax: filterOptions.priceMax,
            notice: req.query.notice || null,
        });
    } catch (error) {
        console.error("Load Product Listing Error:", error);
        res.status(500).send("Something went wrong");
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

module.exports = { loadProductListing, loadProductDetail };
