const Offer = require("../../models/product/offerModel");
const Coupon = require("../../models/order/couponModel");

/**
 * Standard shipping rule: Free delivery above ₹1,000, else ₹100 flat fee.
 */
const SHIPPING_THRESHOLD = 1000;
const SHIPPING_FLAT_FEE = 100;

const calculateShippingFee = (subtotal) => {
    return subtotal >= SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
};

/**
 * Finds the best active offer for a product and its category.
 * Rule: Apply the eligible product or category offer that produces the greatest real savings for the variant.
 * Respects maxDiscount caps when comparing actual savings (Findings 47 & 48).
 */
const getBestActiveOffer = async (productId, categoryId, now = new Date(), regularPrice = null) => {
    if (!productId) return null;

    const query = {
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [
            { offerType: "PRODUCT", productId: productId },
            ...(categoryId ? [{ offerType: "CATEGORY", categoryId: categoryId }] : []),
        ],
    };

    const offers = await Offer.find(query).lean();
    if (!offers || offers.length === 0) return null;

    let bestOffer = null;
    let highestSavings = -1;

    for (const off of offers) {
        let savings = 0;
        if (regularPrice != null && Number.isFinite(Number(regularPrice)) && Number(regularPrice) > 0) {
            const regPrice = Number(regularPrice);
            if (off.discountType === "PERCENTAGE") {
                const rawDiscount = (regPrice * off.discountValue) / 100;
                savings = off.maxDiscount != null ? Math.min(rawDiscount, off.maxDiscount) : rawDiscount;
            } else if (off.discountType === "FLAT") {
                savings = Math.min(regPrice, off.discountValue);
            }
        } else {
            // When regularPrice is not known, compare discount rates / values as fallback
            savings = off.discountValue;
        }

        if (savings > highestSavings) {
            highestSavings = savings;
            bestOffer = off;
        } else if (savings === highestSavings && bestOffer) {
            // Tie-break: product-specific offer wins over category offer
            if (off.offerType === "PRODUCT" && bestOffer.offerType === "CATEGORY") {
                bestOffer = off;
            }
        }
    }

    return bestOffer;
};

/**
 * Calculates effective unit price for a variant given its product, category, and active offers.
 * Respects existing salePrice without double-discounting.
 * Uses exact paise precision for percentage calculations (Finding 49).
 * If variant salePrice is lower than the offer price, salePrice wins and appliedOffer is null (Finding 50).
 */
const calculateItemPrice = (variant, product, offer = null) => {
    const regularPrice = Number(variant?.regularPrice) || 0;
    const baseSalePrice = variant?.salePrice != null && Number.isFinite(Number(variant.salePrice))
        ? Number(variant.salePrice)
        : null;

    let offerDiscount = 0;
    let appliedOffer = null;

    if (offer && regularPrice > 0) {
        if (offer.discountType === "PERCENTAGE") {
            const rawDiscountPaise = Math.round((regularPrice * 100 * offer.discountValue) / 100);
            const maxDiscountPaise = offer.maxDiscount != null ? Math.round(offer.maxDiscount * 100) : null;
            const offerDiscountPaise = maxDiscountPaise != null
                ? Math.min(rawDiscountPaise, maxDiscountPaise)
                : rawDiscountPaise;
            offerDiscount = offerDiscountPaise / 100;
        } else if (offer.discountType === "FLAT") {
            offerDiscount = Math.min(regularPrice, Math.round(Number(offer.discountValue) * 100) / 100);
        }

        if (offerDiscount > 0) {
            appliedOffer = {
                offerId: offer._id,
                name: offer.name,
                offerType: offer.offerType,
                discountType: offer.discountType,
                discountValue: offer.discountValue,
                unitDiscount: offerDiscount,
            };
        }
    }

    const priceAfterOffer = Math.max(0, Math.round((regularPrice - offerDiscount) * 100) / 100);
    let effectiveUnitPrice = priceAfterOffer;

    // Finding 50: If baseSalePrice is strictly lower than priceAfterOffer, variant salePrice was the winner,
    // so the offer was NOT applied.
    if (baseSalePrice != null && baseSalePrice < effectiveUnitPrice) {
        effectiveUnitPrice = baseSalePrice;
        appliedOffer = null;
    }

    const totalDiscount = Math.max(0, Math.round((regularPrice - effectiveUnitPrice) * 100) / 100);

    return {
        regularPrice,
        baseSalePrice,
        effectiveUnitPrice,
        unitOfferDiscount: appliedOffer ? offerDiscount : 0,
        totalReduction: totalDiscount,
        appliedOffer,
    };
};

/**
 * Reusable helper for listing, detail, and wishlist to compute authoritative price
 * using the exact same offer and sale price rules (Findings 51 & 52).
 */
const getAuthoritativeItemPrice = async (variant, product, now = new Date()) => {
    if (!variant) return { displayPrice: 0, regularPrice: 0, effectiveUnitPrice: 0, appliedOffer: null };
    const regPrice = Number(variant.regularPrice) || 0;
    const catId = product?.categoryId?._id || product?.categoryId || null;
    const prodId = product?._id || variant.productId || null;

    const bestOffer = await getBestActiveOffer(prodId, catId, now, regPrice);
    const pricing = calculateItemPrice(variant, product, bestOffer);

    return {
        displayPrice: pricing.effectiveUnitPrice,
        regularPrice: pricing.regularPrice,
        baseSalePrice: pricing.baseSalePrice,
        effectiveUnitPrice: pricing.effectiveUnitPrice,
        appliedOffer: pricing.appliedOffer,
    };
};

/**
 * Allocates an order-level coupon discount deterministically across line items in integer paise.
 * Ensures sum(allocatedDiscounts) === totalCouponDiscount exactly.
 */
const allocateCouponDiscount = (items, totalCouponDiscount) => {
    if (!items || items.length === 0) return items;
    if (!totalCouponDiscount || totalCouponDiscount <= 0) {
        return items.map((item) => ({
            ...item,
            allocatedCouponDiscount: 0,
            finalPayable: item.lineTotal,
        }));
    }

    const totalSubtotalPaise = Math.round(
        items.reduce((sum, i) => sum + (Number(i.lineTotal) || 0), 0) * 100
    );
    const couponPaise = Math.round(Number(totalCouponDiscount) * 100);

    if (totalSubtotalPaise <= 0 || couponPaise <= 0) {
        return items.map((item) => ({
            ...item,
            allocatedCouponDiscount: 0,
            finalPayable: item.lineTotal,
        }));
    }

    let allocatedSumPaise = 0;
    const allocatedItems = items.map((item) => {
        const itemLineTotalPaise = Math.round((Number(item.lineTotal) || 0) * 100);
        const itemSharePaise = Math.floor((itemLineTotalPaise * couponPaise) / totalSubtotalPaise);
        allocatedSumPaise += itemSharePaise;
        return {
            ...item,
            itemLineTotalPaise,
            allocatedPaise: itemSharePaise,
        };
    });

    // Distribute remainder paise to largest item to ensure exact sum match
    let remainderPaise = couponPaise - allocatedSumPaise;
    if (remainderPaise > 0) {
        const sortedIndices = allocatedItems
            .map((item, idx) => ({ idx, total: item.itemLineTotalPaise }))
            .sort((a, b) => b.total - a.total);

        for (let i = 0; i < sortedIndices.length && remainderPaise > 0; i++) {
            allocatedItems[sortedIndices[i].idx].allocatedPaise += 1;
            remainderPaise -= 1;
        }
    }

    return allocatedItems.map((item) => {
        const allocatedCouponDiscount = item.allocatedPaise / 100;
        const finalPayable = Math.max(0, (item.itemLineTotalPaise - item.allocatedPaise) / 100);
        const { itemLineTotalPaise, allocatedPaise, ...cleanItem } = item;
        return {
            ...cleanItem,
            allocatedCouponDiscount,
            finalPayable,
        };
    });
};

/**
 * Authoritative Central Pricing Calculator for Cart, Checkout, and Order Creation.
 * Accepts cart items, evaluates active offers and optional coupon, and calculates exact paise totals.
 */
const calculateCartPricing = async (cartItems, couponCode = "", userId = null) => {
    const now = new Date();
    const pricedItems = [];

    let rawSubtotal = 0; // based on original regular prices
    let effectiveSubtotal = 0; // based on post-offer prices
    let totalOfferDiscount = 0;

    for (const item of cartItems) {
        const variant = item.variant;
        const product = item.product || {};
        const quantity = Number(item.quantity) || 1;

        const regPrice = Number(variant?.regularPrice) || 0;
        const bestOffer = await getBestActiveOffer(product._id, product.categoryId, now, regPrice);
        const pricing = calculateItemPrice(variant, product, bestOffer);

        const lineRegularTotal = pricing.regularPrice * quantity;
        const lineEffectiveTotal = pricing.effectiveUnitPrice * quantity;
        const lineOfferDiscount = (pricing.regularPrice - pricing.effectiveUnitPrice) * quantity;

        // Only available items contribute to subtotal calculations (Finding 76)
        if (item.isAvailable !== false) {
            rawSubtotal += lineRegularTotal;
            effectiveSubtotal += lineEffectiveTotal;
            totalOfferDiscount += lineOfferDiscount;
        }

        pricedItems.push({
            variantId: variant._id,
            productId: product._id,
            productName: product.name || item.productName || "Product",
            productSlug: product.slug || item.productSlug || "",
            thumbnail: product.thumbnail || item.thumbnail || (variant.images && variant.images[0]) || "",
            color: variant.color || "",
            size: variant.size || "",
            sku: variant.sku || "",
            brand: product.brand || "",
            categoryId: product.categoryId || null,
            quantity,
            regularPrice: pricing.regularPrice,
            originalUnitPrice: pricing.regularPrice,
            effectiveUnitPrice: pricing.effectiveUnitPrice,
            unitPrice: pricing.effectiveUnitPrice,
            priceAtPurchase: pricing.effectiveUnitPrice,
            lineTotal: lineEffectiveTotal,
            offerId: pricing.appliedOffer ? pricing.appliedOffer.offerId : null,
            offerName: pricing.appliedOffer ? pricing.appliedOffer.name : "",
            offerDiscount: pricing.appliedOffer ? pricing.appliedOffer.unitDiscount : 0,
            totalOfferDiscount: lineOfferDiscount,
            appliedOffer: pricing.appliedOffer,
        });
    }

    // Evaluate Coupon if provided
    let couponDiscount = 0;
    let appliedCoupon = null;
    let couponError = null;

    if (couponCode && typeof couponCode === "string" && couponCode.trim()) {
        const cleanCode = couponCode.trim().toUpperCase();
        const coupon = await Coupon.findOne({
            code: cleanCode,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
        }).lean();

        if (!coupon) {
            couponError = "Coupon is invalid or has expired.";
        } else if (effectiveSubtotal < (coupon.minPurchase || 0)) {
            couponError = `Coupon requires a minimum purchase of ₹${coupon.minPurchase.toLocaleString("en-IN")}.`;
        } else if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
            couponError = "This coupon has reached its maximum usage limit.";
        } else {
            // Check per-user limit
            if (userId) {
                const userUsage = coupon.usersUsed?.find(
                    (u) => u.userId.toString() === userId.toString()
                );
                if (userUsage && userUsage.usageCount >= (coupon.perUserLimit || 1)) {
                    couponError = "You have already used this coupon the maximum allowed number of times.";
                }
            }

            if (!couponError) {
                if (coupon.discountType === "PERCENTAGE") {
                    const rawCouponPaise = Math.round((effectiveSubtotal * 100 * coupon.discountValue) / 100);
                    const maxCouponPaise = coupon.maxDiscount != null ? Math.round(coupon.maxDiscount * 100) : null;
                    const couponDiscountPaise = maxCouponPaise != null
                        ? Math.min(rawCouponPaise, maxCouponPaise)
                        : rawCouponPaise;
                    couponDiscount = couponDiscountPaise / 100;
                } else if (coupon.discountType === "FLAT") {
                    couponDiscount = Math.min(effectiveSubtotal, Math.round(Number(coupon.discountValue) * 100) / 100);
                }

                appliedCoupon = {
                    couponId: coupon._id,
                    code: coupon.code,
                    discountType: coupon.discountType,
                    discountValue: coupon.discountValue,
                    discountAmount: couponDiscount,
                };
            }
        }
    }

    const shippingFee = calculateShippingFee(effectiveSubtotal);
    const totalAmount = Math.max(0, Math.round((effectiveSubtotal - couponDiscount + shippingFee) * 100) / 100);

    // Allocate order-level coupon discount deterministically across items
    const finalItems = allocateCouponDiscount(pricedItems, couponDiscount);

    return {
        items: finalItems,
        rawSubtotal,
        subtotal: effectiveSubtotal,
        totalOfferDiscount,
        couponDiscount,
        appliedCoupon,
        couponError,
        shippingFee,
        shippingThreshold: SHIPPING_THRESHOLD,
        totalAmount,
    };
};

const calculateOfferSavings = (regularPrice, offer) => {
    if (!offer || !regularPrice || regularPrice <= 0) return 0;
    const regPrice = Number(regularPrice);
    if (offer.discountType === "PERCENTAGE") {
        const rawDiscountPaise = Math.round((regPrice * 100 * offer.discountValue) / 100);
        const maxDiscountPaise = offer.maxDiscount != null ? Math.round(offer.maxDiscount * 100) : null;
        const offerDiscountPaise = maxDiscountPaise != null ? Math.min(rawDiscountPaise, maxDiscountPaise) : rawDiscountPaise;
        return offerDiscountPaise / 100;
    }
    if (offer.discountType === "FLAT") {
        return Math.min(regPrice, Math.round(Number(offer.discountValue) * 100) / 100);
    }
    return 0;
};

module.exports = {
    SHIPPING_THRESHOLD,
    SHIPPING_FLAT_FEE,
    calculateShippingFee,
    getBestActiveOffer,
    calculateOfferSavings,
    calculateItemPrice,
    getAuthoritativeItemPrice,
    allocateCouponDiscount,
    calculateCartPricing,
};
