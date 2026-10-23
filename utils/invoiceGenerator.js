const PDFDocument = require("pdfkit");

/**
 * Generates and streams a professional, multipage-safe PDF tax invoice
 * using authoritative purchase snapshots and current order adjustments.
 */
const generateInvoicePdf = (order, res) => {
    const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        bufferPages: true,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename=invoice-${order.orderNumber}.pdf`
    );

    doc.pipe(res);

    const isOrderCancelled = order.orderStatus === "CANCELLED";

    const printHeader = (isFirstPage = true) => {
        if (isFirstPage) {
            // Header Branding
            doc
                .fontSize(22)
                .font("Helvetica-Bold")
                .fillColor("#111111")
                .text("VELORA", 50, 45)
                .fontSize(8.5)
                .font("Helvetica")
                .fillColor("#666666")
                .text("Contemporary Luxury & Timeless Fashion", 50, 72)
                .text("www.velorastore.com | support@velora.com", 50, 84);

            // Invoice Meta (Right side)
            doc
                .fontSize(15)
                .font("Helvetica-Bold")
                .fillColor(isOrderCancelled ? "#991b1b" : "#111111")
                .text(isOrderCancelled ? "TAX INVOICE (CANCELLED)" : "TAX INVOICE", 310, 45, { align: "right", width: 235 })
                .fontSize(8.5)
                .font("Helvetica")
                .fillColor("#444444")
                .text(`Order ID: ${order.orderNumber}`, 310, 68, { align: "right", width: 235 })
                .text(`Invoice No: INV-${order.orderNumber}`, 310, 81, { align: "right", width: 235 })
                .text(
                    `Order Date: ${new Date(order.placedAt || order.createdAt).toLocaleDateString("en-IN")}`,
                    310,
                    94,
                    { align: "right", width: 235 }
                )
                .text(`Payment: ${order.paymentMethod} (${order.paymentStatus})`, 310, 107, { align: "right", width: 235 })
                .text(`Status: ${order.orderStatus.replace(/_/g, " ")}`, 310, 120, { align: "right", width: 235 });

            let headerBottom = 138;
            if (isOrderCancelled) {
                const cancelText = `ORDER CANCELLED on ${order.cancelledAt ? new Date(order.cancelledAt).toLocaleDateString("en-IN") : "N/A"}${order.cancellationReason ? " | Reason: " + order.cancellationReason : ""}`;
                doc.fontSize(8).font("Helvetica-Bold");
                const bannerTextHeight = doc.heightOfString(cancelText, { width: 485, align: "center" });
                const bannerHeight = Math.max(22, bannerTextHeight + 8);
                doc.rect(50, 136, 495, bannerHeight).fillAndStroke("#fee2e2", "#fca5a5");
                doc
                    .fillColor("#991b1b")
                    .text(cancelText, 55, 140, { width: 485, align: "center" });
                headerBottom = 136 + bannerHeight + 8;
            }

            doc.moveTo(50, headerBottom).lineTo(545, headerBottom).strokeColor("#e5e7eb").lineWidth(1).stroke();

            // Shipping Address with dynamic text measurement
            let shipY = headerBottom + 10;
            doc
                .fontSize(9)
                .font("Helvetica-Bold")
                .fillColor("#111111")
                .text("SHIPPING & BILLING ADDRESS:", 50, shipY);
            shipY += 14;

            doc.font("Helvetica").fontSize(8.5).fillColor("#333333");
            const fullName = `${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`;
            doc.text(fullName, 50, shipY);
            shipY += doc.heightOfString(fullName, { width: 350 }) + 3;

            const addrLine = `${order.shippingAddress.addressLine1}${order.shippingAddress.addressLine2 ? ", " + order.shippingAddress.addressLine2 : ""}`;
            doc.text(addrLine, 50, shipY, { width: 350 });
            shipY += doc.heightOfString(addrLine, { width: 350 }) + 3;

            const cityState = `${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pinCode}`;
            doc.text(cityState, 50, shipY);
            shipY += doc.heightOfString(cityState, { width: 350 }) + 3;

            const countryPhone = `${order.shippingAddress.country} | Phone: ${order.shippingAddress.phone}`;
            doc.text(countryPhone, 50, shipY);
            shipY += doc.heightOfString(countryPhone, { width: 350 }) + 10;

            return shipY;
        } else {
            // Continuation header for multipage documents
            doc
                .fontSize(9)
                .font("Helvetica")
                .fillColor("#666666")
                .text(`VELORA TAX INVOICE — Order #${order.orderNumber} (Continued)`, 50, 35)
                .moveTo(50, 48)
                .lineTo(545, 48)
                .strokeColor("#e5e7eb")
                .lineWidth(0.8)
                .stroke();
            return 58;
        }
    };

    const printTableHeader = (yPos) => {
        doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor("#e5e7eb").lineWidth(0.8).stroke();
        doc
            .fontSize(8)
            .font("Helvetica-Bold")
            .fillColor("#111111")
            .text("ITEM DESCRIPTION & STATUS", 50, yPos + 5)
            .text("QTY", 310, yPos + 5, { width: 40, align: "center" })
            .text("UNIT PRICE", 360, yPos + 5, { width: 85, align: "right" })
            .text("AMOUNT", 455, yPos + 5, { width: 90, align: "right" });
        doc.moveTo(50, yPos + 18).lineTo(545, yPos + 18).strokeColor("#111111").lineWidth(0.8).stroke();
        return yPos + 24;
    };

    let currentY = printHeader(true);
    currentY = printTableHeader(currentY);

    const checkPageBreak = (neededHeight) => {
        if (currentY + neededHeight > 720) {
            doc.addPage();
            currentY = printHeader(false);
            currentY = printTableHeader(currentY);
        }
    };

    // Render Items with dynamic height measurement
    order.items.forEach((item) => {
        const itemStatus = (item.status || "PENDING").toUpperCase();
        const isItemCancelled = itemStatus === "CANCELLED" || isOrderCancelled;
        const isItemReturned = itemStatus === "RETURNED";

        let statusTag = "";
        if (isItemCancelled) statusTag = " [CANCELLED]";
        else if (isItemReturned) statusTag = " [RETURNED]";
        else if (itemStatus === "RETURN_REQUESTED") statusTag = " [RETURN REQUESTED]";
        else if (itemStatus === "RETURN_APPROVED") statusTag = " [RETURN ACCEPTED]";
        else if (itemStatus === "RETURN_REJECTED") statusTag = " [RETURN REJECTED]";
        else if (itemStatus === "OUT_FOR_DELIVERY") statusTag = " [OUT FOR DELIVERY]";
        else if (itemStatus !== "DELIVERED" && itemStatus !== "PENDING" && itemStatus !== "PROCESSING") {
            statusTag = ` [${itemStatus.replace(/_/g, " ")}]`;
        }

        const itemDesc = `${item.productName}${item.color ? " (" + item.color + ")" : ""}${item.size ? " - Size: " + item.size : ""}${item.sku ? " [SKU: " + item.sku + "]" : ""}${statusTag}`;

        doc.fontSize(8).font("Helvetica");
        const descHeight = doc.heightOfString(itemDesc, { width: 250 });

        doc.fontSize(7.5);
        let reasonHeight = 0;
        let reasonText = "";
        if (isItemCancelled && item.cancellationReason) {
            reasonText = `Reason: ${item.cancellationReason}`;
            reasonHeight = doc.heightOfString(reasonText, { width: 240 }) + 4;
        }

        let feedbackHeight = 0;
        let feedbackText = "";
        if (item.adminFeedback) {
            feedbackText = `Admin Feedback: ${item.adminFeedback}`;
            feedbackHeight = doc.heightOfString(feedbackText, { width: 240 }) + 4;
        }

        const rowHeight = Math.max(descHeight, 14) + reasonHeight + feedbackHeight + 8;
        checkPageBreak(rowHeight);

        // Print row details
        doc
            .fontSize(8)
            .font(isItemCancelled ? "Helvetica-Oblique" : isItemReturned ? "Helvetica-Oblique" : "Helvetica")
            .fillColor(isItemCancelled ? "#991b1b" : isItemReturned ? "#c2410c" : "#222222")
            .text(itemDesc, 50, currentY, { width: 250 })
            .text(String(item.quantity), 310, currentY, { width: 40, align: "center" })
            .text(`INR ${item.unitPrice.toLocaleString("en-IN")}`, 360, currentY, { width: 85, align: "right" });

        let amountText = `INR ${item.lineTotal.toLocaleString("en-IN")}`;
        if (isItemCancelled) {
            amountText = "INR 0 (Void)";
        } else if (isItemReturned) {
            amountText = "INR 0 (Returned)";
        }

        doc.text(amountText, 455, currentY, { width: 90, align: "right" });

        let subY = currentY + Math.max(descHeight, 14) + 2;

        if (reasonText) {
            doc
                .fontSize(7.5)
                .fillColor("#b91c1c")
                .text(reasonText, 60, subY, { width: 240 });
            subY += doc.heightOfString(reasonText, { width: 240 }) + 4;
        }

        if (feedbackText) {
            doc
                .fontSize(7.5)
                .fillColor("#4b5563")
                .text(feedbackText, 60, subY, { width: 240 });
            subY += doc.heightOfString(feedbackText, { width: 240 }) + 4;
        }

        currentY += rowHeight;
        doc.moveTo(50, currentY - 2).lineTo(545, currentY - 2).strokeColor("#f3f4f6").lineWidth(0.5).stroke();
    });

    // Summary Section with dynamic height calculation
    let summaryHeight = 65; // base lines + dividers + total
    if (order.pricing?.taxAmount > 0) summaryHeight += 15;
    if (order.pricing?.discount > 0) summaryHeight += 15;
    if (order.pricing?.cancellationDeduction > 0) summaryHeight += 15;
    if (order.pricing?.returnCredit > 0) summaryHeight += 15;

    checkPageBreak(summaryHeight + 30);

    doc.moveTo(50, currentY + 2).lineTo(545, currentY + 2).strokeColor("#e5e7eb").lineWidth(1).stroke();
    currentY += 12;

    const summaryLabelX = 330;
    const summaryValX = 455;
    const summaryValWidth = 90;

    const originalSubtotal = order.pricing?.originalSubtotal !== undefined
        ? order.pricing.originalSubtotal
        : (order.pricing?.subtotal || 0);

    const originalShipping = order.pricing?.originalShippingFee !== undefined
        ? order.pricing.originalShippingFee
        : (order.pricing?.shippingFee || 0);

    doc
        .fontSize(8.5)
        .font("Helvetica")
        .fillColor("#555555")
        .text("Original Subtotal:", summaryLabelX, currentY)
        .text(`INR ${originalSubtotal.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });

    if (order.pricing?.taxAmount > 0) {
        currentY += 15;
        doc
            .text("Estimated Tax (5%):", summaryLabelX, currentY)
            .text(`INR ${order.pricing.taxAmount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    currentY += 15;
    doc
        .text("Shipping Fee:", summaryLabelX, currentY)
        .text(
            originalShipping === 0 ? "FREE" : `INR ${originalShipping.toLocaleString("en-IN")}`,
            summaryValX,
            currentY,
            { width: summaryValWidth, align: "right" }
        );

    if (order.pricing?.saleDiscount > 0) {
        currentY += 15;
        doc
            .text("Sale Savings:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.saleDiscount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.offerDiscount > 0) {
        currentY += 15;
        doc
            .text("Offer Savings:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.offerDiscount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.couponDiscount > 0) {
        currentY += 15;
        doc
            .text(`Coupon (${order.pricing.couponCode || 'Code'}):`, summaryLabelX, currentY)
            .text(`-INR ${order.pricing.couponDiscount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    } else if (order.pricing?.discount > 0 && !(order.pricing?.offerDiscount > 0)) {
        currentY += 15;
        doc
            .text("Discount:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.discount.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.walletRefundIssued > 0) {
        currentY += 15;
        doc
            .fillColor("#b91c1c")
            .text("Wallet Refund Issued:", summaryLabelX, currentY)
            .text(`INR ${order.pricing.walletRefundIssued.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.cancellationDeduction > 0) {
        currentY += 15;
        doc
            .fillColor("#b91c1c")
            .text("Cancelled Items Adjustment:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.cancellationDeduction.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    if (order.pricing?.returnCredit > 0) {
        currentY += 15;
        doc
            .fillColor("#c2410c")
            .text("Return Credit Adjustment:", summaryLabelX, currentY)
            .text(`-INR ${order.pricing.returnCredit.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });
    }

    currentY += 14;
    doc.moveTo(summaryLabelX, currentY).lineTo(545, currentY).strokeColor("#111111").lineWidth(0.8).stroke();
    currentY += 6;

    const finalPayable = order.pricing?.currentPayable !== undefined
        ? order.pricing.currentPayable
        : (isOrderCancelled ? 0 : (order.pricing?.totalAmount || 0));

    doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor(isOrderCancelled ? "#991b1b" : "#000000")
        .text("Total Payable / Paid:", summaryLabelX, currentY)
        .text(`INR ${finalPayable.toLocaleString("en-IN")}`, summaryValX, currentY, { width: summaryValWidth, align: "right" });

    // Dynamic Safe Footer (Guaranteed not to overlap)
    if (currentY + 60 > 770) {
        doc.addPage();
        currentY = 50;
    } else {
        currentY = Math.max(currentY + 40, 750);
    }

    doc
        .fontSize(7.5)
        .font("Helvetica")
        .fillColor("#888888")
        .text("This is an electronically generated invoice and does not require a physical signature.", 50, currentY, { align: "center", width: 495 })
        .text("Thank you for choosing VELORA Store. For customer support, visit www.velorastore.com", 50, currentY + 12, { align: "center", width: 495 });

    doc.end();
};

module.exports = { generateInvoicePdf };
