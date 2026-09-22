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

    if (isDefault) {
        await Address.updateMany({ userId }, { isDefault: false });
    }

    const existingCount = await Address.countDocuments({ userId });

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
        isDefault: existingCount === 0 ? true : !!isDefault, // first address is always default
        userId,
    });

    return { success: true, address };
};

const updateAddress = async (userId, addressId, data) => {
    const { firstName, lastName, addressLine1, addressLine2, phone, pinCode, city, state, country, isDefault } = data;

    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    if (isDefault) {
        await Address.updateMany({ userId }, { isDefault: false });
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
    address.isDefault = !!isDefault;

    await address.save();

    return { success: true, address };
};

const deleteAddress = async (userId, addressId) => {
    const address = await Address.findOneAndDelete({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    // if the deleted address was default, promote another one if any remain
    if (address.isDefault) {
        const remaining = await Address.findOne({ userId }).sort({ createdAt: -1 });
        if (remaining) {
            remaining.isDefault = true;
            await remaining.save();
        }
    }

    return { success: true };
};

const setDefaultAddress = async (userId, addressId) => {
    const address = await Address.findOne({ _id: addressId, userId });
    if (!address) {
        return { success: false, message: "Address not found" };
    }

    await Address.updateMany({ userId }, { isDefault: false });
    address.isDefault = true;
    await address.save();

    return { success: true };
};

module.exports = {
    getAddresses,
    getAddressById,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
};
