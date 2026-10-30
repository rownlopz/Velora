const {
    getInventory,
    updateVariantStock,
    adjustVariantStock,
} = require("../../services/admin/inventoryService");

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

        res.render("admin/inventory", result);
    } catch (error) {
        console.error("Admin Load Inventory Error:", error);
        res.status(500).send("Something went wrong");
    }
};

const updateStockController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { variantId } = req.params;
        const { stock } = req.body;
        const result = await updateVariantStock(variantId, stock);

        if (isAjax) return res.status(result.success ? 200 : 400).json(result);
        return res.redirect(`/admin/inventory?${result.success ? "success" : "error"}=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Admin Update Stock Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Internal server error" });
        res.redirect("/admin/inventory?error=Something+went+wrong");
    }
};

const quickAdjustStockController = async (req, res) => {
    const isAjax = req.headers["x-requested-with"] === "XMLHttpRequest" || req.headers.accept?.includes("application/json");
    try {
        const { variantId } = req.params;
        const { delta } = req.body;
        const result = await adjustVariantStock(variantId, delta);

        if (isAjax) return res.status(result.success ? 200 : 400).json(result);
        return res.redirect(`/admin/inventory?${result.success ? "success" : "error"}=${encodeURIComponent(result.message)}`);
    } catch (error) {
        console.error("Admin Adjust Stock Error:", error);
        if (isAjax) return res.status(500).json({ success: false, message: "Internal server error" });
        res.redirect("/admin/inventory?error=Something+went+wrong");
    }
};

module.exports = {
    loadInventory,
    updateStockController,
    quickAdjustStockController,
};
