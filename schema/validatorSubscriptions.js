import mongoose from 'mongoose';

const validatorSubscriptionSchema = new mongoose.Schema({
    validatorAddress: { type: String, required: true }, 
    validatorVoteAddress: { type: String }, 
    subscriptions: [{
        serverId: { type: String, required: true },
        channelId: { type: String, required: true },
        addedAt: { type: Date, default: Date.now },
		createdBy: { type: String, required: true },
        normalStatus: { type: Boolean, default: true },
        updatingStatus: {
            status: { type: Boolean, default: false },
            channelId: { type: String, default: "" },
            messageId: { type: String, default: "" }
        }
    }],
    createdAt: { type: Date, default: Date.now },
});

validatorSubscriptionSchema.index({ validatorAddress: 1 });
validatorSubscriptionSchema.index({ 'subscriptions.serverId': 1, 'subscriptions.channelId': 1 });
validatorSubscriptionSchema.index({ active: 1 });

const ValidatorSubscription = mongoose.model('ValidatorSubscription', validatorSubscriptionSchema);

export default ValidatorSubscription;