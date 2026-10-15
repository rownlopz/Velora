const {
    getInventory,
    updateVariantStock,
    adjustVariantStock,
} = require("../../services/admin/inventoryService");

/**
 * Lists all product variants with inventory metrics, filters, search, and sorting
 */
const loadInventory = async (req, res) => {
    try {
        const {
            search = "",
            status = "all",
            categoryId = "all",
            sort = "stock_asc",
            page = 1,
        } = req.query;

        const result = await getInventory({
            search,
            status,
            categoryId,
            sort,
            page: parseInt(page, 10) || 1,
            limit: 10,
        });

        res.render("admin/inventory", {
            items: result.items,
            totalVariants: result.totalVariants,
            totalPages: result.totalPages,
            currentPage: result.currentPage,
            stats: result.stats,
            categories: result.categories,
            search: result.search,
            status: result.status,
            categoryId: result.categoryId,
            sort: result.sort,
        });
    } catch (error) {
        console.error("Admin Load Inventory Error:", error);
        res.status(500).send("Something went wrong");
    }
};

/**
 * Update variant stock count
 */
const updateStockController = async (req, res) => {
    const isAjax =
        req.headers["x-requested-with"] === "XMLHttpRequest" ||
        req.headers.accept?.includes("application/json");

    try {
        const { variantId } = req.params;
        const { stock } = req.body;

        const result = await updateVariantStock(variantId, stock);

        if (!result.success) {
            if (isAjax) {
                return res.status(400).json({ success: false, message: result.message });
            }
            return res.redirect(`/admin/inventory?error=${encodeURIComponent(result.message)}`);
        }

        if (isAjax) {
            return res.json({
                success: true,
                message: result.message,
                newStock: result.newStock,
                variantId: result.variantId,
            });
        }

        return res.redirect(`/admin/inventory?success=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Admin Update Stock Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error" });
        }
        res.redirect("/admin/inventory?error=Something+went+wrong");
    }
};

/**
 * Increment or decrement stock by delta (+1, -1, +5, etc.)
 */
const quickAdjustStockController = async (req, res) => {
    const isAjax =
        req.headers["x-requested-with"] === "XMLHttpRequest" ||
        req.headers.accept?.includes("application/json");

    try {
        const { variantId } = req.params;
        const { delta } = req.body;

        const result = await adjustVariantStock(variantId, delta);

        if (!result.success) {
            if (isAjax) {
                return res.status(400).json({ success: false, message: result.message });
            }
            return res.redirect(`/admin/inventory?error=${encodeURIComponent(result.message)}`);
        }

        if (isAjax) {
            return res.json({
                success: true,
                message: result.message,
                newStock: result.newStock,
                variantId: result.variantId,
            });
        }

        return res.redirect(`/admin/inventory?success=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Admin Quick Adjust Stock Error:", error);
        if (isAjax) {
            return res.status(500).json({ success: false, message: "Internal server error" });
        }
        res.redirect("/admin/inventory?error=Something+went+wrong");
    }
};

module.exports = {
    loadInventory,
    updateStockController,
    quickAdjustStockController,
};
