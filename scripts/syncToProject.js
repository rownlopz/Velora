const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'Week15Project');


const files = [
    'config/db.js',
    'controllers/admin/inventoryController.js',
    'controllers/user/userController.js',
    'controllers/user/orderController.js',
    'controllers/user/wishlistController.js',
    'helpers/orderStatusHelper.js',
    'helpers/restoreCancellationStock.js',
    'helpers/restoreReturnStock.js',
    'models/order/cartModel.js',
    'models/order/orderModel.js',
    'models/product/productModel.js',
    'models/product/variantModel.js',
    'services/admin/adminService.js',
    'services/admin/categoryService.js',
    'services/admin/inventoryService.js',
    'services/admin/orderService.js',
    'services/admin/productService.js',
    'services/user/cartService.js',
    'services/user/orderService.js',
    'services/user/productListService.js',
    'services/user/wishlistService.js',
    'utils/escapeRegex.js',
    'utils/invoiceGenerator.js',
    'views/admin/inventory.ejs',
    'views/admin/order-details.ejs',
    'views/admin/orders.ejs',
    'views/admin/partials/topbar.ejs',
    'views/admin/product-form.ejs',
    'views/partials/storeHeader.ejs',
    'views/user/product-detail.ejs',
    'views/user/wishlist.ejs'
];

for (const rel of files) {
    const src = path.join(root, rel);
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`Synced: ${rel}`);
}
