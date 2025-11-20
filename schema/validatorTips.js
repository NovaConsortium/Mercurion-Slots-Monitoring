import mongoose from 'mongoose';

const validatorTipsSchema = new mongoose.Schema({
    validatorAddress: { 
        type: String, 
        required: true,
        unique: true,
        index: true 
    },
    lastUpdated: { 
        type: Date, 
        default: Date.now 
    },
    epochs: [{
        epochNumber: { 
            type: Number, 
            required: true 
        },
        totalTipsSOL: { 
            type: Number, 
            default: 0 
        },
        totalTipsLamports: { 
            type: Number, 
            default: 0 
        },
        blockCount: { 
            type: Number, 
            default: 0 
        },
        epochStartDate: { 
            type: Date, 
            default: Date.now 
        },
        epochEndDate: { 
            type: Date 
        }
    }]
});





const ValidatorTips = mongoose.model('ValidatorTips', validatorTipsSchema);

export default ValidatorTips;