const Address = require("../../models/user/addressModel");

const getAddresses = async (userId) => {
    const addresses = await Address.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
    return { success: true, addresses };
};

const getAddressById = async (userId, addressId) => {
    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }
    return { success: true, address };
};

const addAddress = async (userId, data) => {
    const { firstName, lastName, addressLine1, addressLine2, phone, pinCode, city, state, country, isDefault } = data;
    const User = require("../../models/user/userModel");

    const existingCount = await Address.countDocuments({ userId });
    const shouldBeDefault = existingCount === 0 ? true : !!isDefault;

    const address = await Address.create({
        firstName,
        lastName,
        addressLine1,
        addressLine2,
        phone,
        pinCode,
        city,
        state,
        country,
        isDefault: shouldBeDefault,
        userId,
    });

    if (shouldBeDefault) {
        await User.findByIdAndUpdate(userId, { $set: { defaultAddressId: address._id } });
        await Address.updateMany({ userId, _id: { $ne: address._id } }, { $set: { isDefault: false } });
    }

    return { success: true, address };
};

const updateAddress = async (userId, addressId, data) => {
    const { firstName, lastName, addressLine1, addressLine2, phone, pinCode, city, state, country, isDefault } = data;
    const User = require("../../models/user/userModel");

    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    const totalCount = await Address.countDocuments({ userId });
    let finalIsDefault = !!isDefault;
    if (totalCount <= 1) {
        finalIsDefault = true;
    } else if (address.isDefault && !isDefault) {
        const other = await Address.findOne({ userId, _id: { $ne: addressId } }).sort({ createdAt: -1 });
        if (other) {
            other.isDefault = true;
            await other.save();
            await User.findByIdAndUpdate(userId, { $set: { defaultAddressId: other._id } });
        } else {
            finalIsDefault = true;
        }
    }

    if (finalIsDefault) {
        await User.findByIdAndUpdate(userId, { $set: { defaultAddressId: addressId } });
        await Address.updateMany({ userId, _id: { $ne: addressId } }, { $set: { isDefault: false } });
    }

    address.firstName = firstName;
    address.lastName = lastName;
    address.addressLine1 = addressLine1;
    address.addressLine2 = addressLine2;
    address.phone = phone;
    address.pinCode = pinCode;
    address.city = city;
    address.state = state;
    address.country = country;
    address.isDefault = finalIsDefault;

    await address.save();

    return { success: true, address };
};

const deleteAddress = async (userId, addressId) => {
    const address = await Address.findOneAndDelete({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    const User = require("../../models/user/userModel");
    const user = await User.findById(userId);
    const isDefaultDeleted = address.isDefault || (user && user.defaultAddressId && user.defaultAddressId.toString() === addressId.toString());

    if (isDefaultDeleted) {
        const remaining = await Address.findOne({ userId }).sort({ createdAt: -1 });
        if (remaining) {
            remaining.isDefault = true;
            await remaining.save();
            await Address.updateMany({ userId, _id: { $ne: remaining._id } }, { $set: { isDefault: false } });
            await User.findByIdAndUpdate(userId, { $set: { defaultAddressId: remaining._id } });
        } else {
            await User.findByIdAndUpdate(userId, { $unset: { defaultAddressId: "" } });
        }
    }

    return { success: true };
};

const setDefaultAddress = async (userId, addressId) => {
    const User = require("../../models/user/userModel");
    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    await User.findByIdAndUpdate(userId, { $set: { defaultAddressId: addressId } });

    const user = await User.findById(userId);
    const authoritativeId = user?.defaultAddressId || addressId;

    await Address.updateMany({ userId, _id: { $ne: authoritativeId } }, { $set: { isDefault: false } });
    await Address.updateOne({ _id: authoritativeId, userId }, { $set: { isDefault: true } });

    return { success: true, address };
};

module.exports = {
    getAddresses,
    getAddressById,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
};
