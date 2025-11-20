import mongoose from 'mongoose';

const validatorDMSubscriptionSchema = new mongoose.Schema({
    validatorAddress: { type: String, required: true, index: true },
    validatorVoteAddress: { type: String, required: true, index: true },
    subscribers: [{
        userId: { type: String, required: true },
        addedAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
});

const ValidatorDMSubscription = mongoose.model('ValidatorDMSubscription', validatorDMSubscriptionSchema);

export default ValidatorDMSubscription;