import 'dotenv/config'
import WebSocket from 'ws';
import { ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorSpacingSize } from "discord.js";
import { Connection } from '@solana/web3.js';
import validatorDMSubscriptionSchema from "./schema/validatorDMSubscriptions.js";
import validatorSubscriptionSchema from './schema/validatorSubscriptions.js';
import validatorTips from './schema/validatorTips.js';
import { loadValidatorLists, getMainnetList } from './validatorList.js';
let ws = null;
let reconnectInterval = null;
let isReconnecting = false;
const pendingRequests = new Map();
import fs from 'fs';
let logStream = fs.createWriteStream("./slotsData/slot-current.jsonl", { flags: "a" });
import client from './index.js';
import { EventEmitter } from 'events';

class SolanaContinuousValidatorMonitor extends EventEmitter {
    constructor() {
        super();
        this.connection = new Connection(process.env.rpcUrl, { commitment: 'confirmed' });
        this.validatorAddresses = [];
        this.currentEpoch = null;
        this.leaderSchedule = {};
        this.lastCheckedSlot = 0;
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.processedSlots = new Set();
        this.isProcessing = false;
        this.solPriceUSD = 0;
        this.lastPriceUpdate = 0;
        this.priceUpdateInterval = 300000;
        this.pendingBlocks = new Map();
        this.batchTimeouts = new Map();
        this.reconnectAttempts = 0;
        this.currentWsUrl = process.env.fdWsEndpoint;
        
        
        this.epochInfoCache = { data: null, timestamp: 0, ttl: 30000 }; 
        this.voteAccountsCache = { data: null, timestamp: 0, ttl: 60000 }; 
        this.validatorDataCache = new Map(); 
        this.validatorListCache = { data: null, timestamp: 0, ttl: 300000 }; 
        
        
        this.slotToValidatorMap = new Map(); 
        
        
        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupCaches();
        }, 300000); 
    }

    connectWebSocket() {
        if (isReconnecting) return;

        console.log('Connecting to WebSocket...');
        ws = new WebSocket(this.currentWsUrl);

        ws.on('open', function open() {
            console.log('WebSocket connected successfully');
            isReconnecting = false;

            this.reconnectAttempts = 0;

            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`WebSocket closed - Code: ${code}, Reason: ${reason}`);
            this.attemptReconnect();
        });

        ws.on('error', (err) => {
            console.error('WebSocket error:', err);
            this.attemptReconnect();
        });

        ws.on("message", (data) => {
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch {
                return;
            }

            if (parsed.topic === "slot" && parsed.key === "update" && parsed.value.publish?.level === "completed") {
                logStream.write(JSON.stringify(parsed.value.publish) + "\n");
            }
            if (parsed.topic === "slot" && parsed.key === "query" && parsed.value?.publish) {
                const slotNum = parsed.value.publish.slot;

                for (const [requestId, req] of pendingRequests.entries()) {
                    if (req.pendingSlots.has(slotNum)) {
                        req.data.push(parsed.value.publish);
                        req.pendingSlots.delete(slotNum);

                        req.totalTips += parsed.value.publish.tips || 0;
                        req.totalFees += (Number(parsed.value.publish.transaction_fee) || 0) +
                            (Number(parsed.value.publish.priority_fee) || 0);

                        if (req.pendingSlots.size === 0) {
                            pendingRequests.delete(requestId);
                            req.resolve({
                                allData: req.data,
                                totalTips: req.totalTips,
                                totalFees: req.totalFees
                            });
                        }
                    }
                }
            }
        });

    }

    attemptReconnect() {
        if (isReconnecting) return;
        isReconnecting = true;
        this.reconnectAttempts++;

        console.log(`Attempting to reconnect WebSocket (#${this.reconnectAttempts}) in 5 seconds...`);

        if (this.reconnectAttempts > 2) {
            if (this.currentWsUrl !== process.env.fdFallbackWs) {
                console.log('Switching to fallback WebSocket URL');
                this.currentWsUrl = process.env.fdFallbackWs;
            }
        }

        if (ws) {
            try {
                ws.removeAllListeners();
                ws.terminate ? ws.terminate() : ws.close();
            } catch (error) {
                console.log("Something Went Wrong With Reconnecting...", error)
            }
            ws = null;
        }

        reconnectInterval = setTimeout(() => {
            isReconnecting = false;
            this.connectWebSocket();
        }, 5000);
    }

    
    getCachedData(cache, fetchFunction) {
        const now = Date.now();
        if (cache.data && (now - cache.timestamp) < cache.ttl) {
            return cache.data;
        }
        return null;
    }

    setCachedData(cache, data) {
        cache.data = data;
        cache.timestamp = Date.now();
    }

    
    cleanupCaches() {
        const now = Date.now();
        
        
        for (const [key, value] of this.validatorDataCache.entries()) {
            if (now - value.timestamp > 300000) { 
                this.validatorDataCache.delete(key);
            }
        }
        
        
        if (this.processedSlots.size > 2000) {
            const slotsArray = Array.from(this.processedSlots).sort((a, b) => a - b);
            this.processedSlots = new Set(slotsArray.slice(-1000));
        }
    }

    async fetchSOLPrice() {
        const now = Date.now();
        if (this.solPriceUSD > 0 && (now - this.lastPriceUpdate) < this.priceUpdateInterval) {
            return this.solPriceUSD;
        }

        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            if (response.ok) {
                const data = await response.json();
                this.solPriceUSD = data.solana?.usd || 0;
                this.lastPriceUpdate = now;
                return this.solPriceUSD;
            }
        } catch (error) {
            console.log("Error fetching SOL price:", error)
            return this.solPriceUSD;
        }

        console.log(this.solPriceUSD)
        return this.solPriceUSD;
    }

    
    async getEpochInfo(commitment = 'confirmed') {
        const cached = this.getCachedData(this.epochInfoCache);
        if (cached) return cached;

        try {
            const epochInfo = await this.connection.getEpochInfo(commitment);
            this.setCachedData(this.epochInfoCache, epochInfo);
            return epochInfo;
        } catch (error) {
            console.error('Error fetching epoch info:', error);
            return null;
        }
    }

    
    async getVoteAccounts() {
        const cached = this.getCachedData(this.voteAccountsCache);
        if (cached) return cached;

        try {
            const voteAccounts = await this.connection.getVoteAccounts();
            this.setCachedData(this.voteAccountsCache, voteAccounts);
            return voteAccounts;
        } catch (error) {
            console.error('Error fetching vote accounts:', error);
            return null;
        }
    }

    
    async getValidatorData(validatorVoteAddress, currentEpoch) {
        const cacheKey = `${validatorVoteAddress}-${currentEpoch}`;
        const cached = this.validatorDataCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < 60000) { 
            return cached.data;
        }

        try {
            const [valiData, jpoolData, jpoolScores, valiStats, pendingStake] = await Promise.all([
                fetch(`https://api.thevalidators.io/validators-history/history?network=mainnet&vote_id=${validatorVoteAddress}&epoch_count=1&epoch_from=${currentEpoch}`).then(r => r.json()),
                fetch(`https://api.jpool.one/validators?fields=apy,is_jito,jito_apy,stake_concentration,data_center,node_ip,jito_commission_bps,skip_rate,uptime&build=0.3.0&vote=${validatorVoteAddress}`).then(r => r.json()),
                fetch(`https://api.thevalidators.io/jpool-scores/${currentEpoch}/${validatorVoteAddress}`).then(r => r.json()),
                fetch(`https://api.thevalidators.io/validators/list?network=mainnet&select=voteId,validatorId,svName,keybaseUsername,iconUrl,name,nodeVersion,slotIndex,leaderSlotsTotal,leaderSlotsDone,leaderSlotsEpoch,details,tvCredits,tvcRank&vote_id=${validatorVoteAddress}`).then(r => r.json()),
                fetch(`https://api.jpool.one/validators/${validatorVoteAddress}/pending-stake?build=0.3.0`).then(r => r.json())
            ]);

            const data = {
                valiData: valiData.data?.[0] || {},
                jpoolData: jpoolData?.[0] || {},
                jpoolScores: jpoolScores.data?.[0] || {},
                valiStats: valiStats.data?.[0] || {},
                pendingStake: pendingStake || {}
            };

            this.validatorDataCache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        } catch (error) {
            console.error('Error fetching validator data:', error);
            return null;
        }
    }

    solToUSD(solAmount) {
        return (parseFloat(solAmount) * this.solPriceUSD).toFixed(2);
    }

    async initialize(validatorAddresses) {
        this.validatorAddresses = validatorAddresses;
        const currentSlot = await this.connection.getSlot('confirmed');
        this.lastCheckedSlot = currentSlot;
        await this.fetchSOLPrice();
        await this.updateLeaderSchedule();
    }

    deepEqual(a, b) {
        if (a === b) return true;
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!this.deepEqual(a[i], b[i])) return false;
            return true;
        }
        if (typeof a === 'object' && a && typeof b === 'object' && b) {
            const ka = Object.keys(a), kb = Object.keys(b);
            if (ka.length !== kb.length) return false;
            for (const k of ka) if (!this.deepEqual(a[k], b[k])) return false;
            return true;
        }
        return false;
    }

    async updateLeaderSchedule(slot = null) {
        try {
            const epochInfo = await this.getEpochInfo('confirmed');
            this.currentEpoch = epochInfo.epoch;

            let newSchedule;
            do {
                const leaderSchedule = await this.connection.getLeaderSchedule(slot, { commitment: 'confirmed' }) || {};
                newSchedule = {};
                this.validatorAddresses.forEach(validator => {
                    newSchedule[validator] = leaderSchedule[validator] || [];
                });

                if (!this.deepEqual(this.leaderSchedule, newSchedule)) {
                    this.leaderSchedule = newSchedule;
                    
                    
                    this.buildSlotLookupMap();
                    
                    break;
                } else {
                    
                    await new Promise(r => setTimeout(r, 5000));
                }
            } while (true);

        } catch (error) {
            console.error('Error updating leader schedule:', error);
        }
    }

    buildSlotLookupMap() {
        
        this.slotToValidatorMap.clear();
        
        
        for (const [validator, slots] of Object.entries(this.leaderSchedule)) {
            for (const relativeSlot of slots) {
                this.slotToValidatorMap.set(relativeSlot, validator);
            }
        }
        
        console.log(`🗺️ Built slot lookup map with ${this.slotToValidatorMap.size} slots for ${Object.keys(this.leaderSchedule).length} validators`);
    }

    isTargetValidatorSlot(slot, epochInfo) {
        const relativeSlot = slot - epochInfo.absoluteSlot + epochInfo.slotIndex;
        
        return this.slotToValidatorMap.get(relativeSlot) || null;
    }

    async getBlockDetails(slot, retryCount = 0) {
        try {
            
            
            return await this.connection.getBlock(slot, {
                encoding: 'json',
                transactionDetails: 'none', 
                rewards: false, 
                maxSupportedTransactionVersion: 0
            });
        } catch (error) {
            if (error.message.includes('429') && retryCount < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
                return await this.getBlockDetails(slot, retryCount + 1);
            }
            return null;
        }
    }

    async getEarnedCurrentEpoch(validatorVoteAddress) {
        const currentEpoch = this.currentEpoch;

        try {
            let res = await fetch(`https://api.thevalidators.io/validators-history/history?network=mainnet&vote_id=${validatorVoteAddress}&epoch_count=1000&epoch_from=${currentEpoch}`);
            res = await res.json();

            const filtered = res.data.filter(item => item.epoch === currentEpoch)[0];
            if (!filtered) return {
                leaderRewards: 0,
                votingFees: 0,
                commissionReward: 0,
                mevCommission: 0
            }
            return {
                leaderRewards: parseFloat(filtered.votingReward) / 1e9,
                votingFees: parseFloat(filtered.votingFee) / 1e9,
                commissionReward: parseFloat(filtered.commissionReward) / 1e9,
                mevCommission: res.data[res.data.length - 2].mevCommission / 10000
            };
        } catch (error) {
            console.error('Error fetching current epoch earnings:', error);
            return {
                leaderRewards: 0,
                votingFees: 0,
                commissionReward: 0,
                mevCommission: 0
            };
        }
    }

    async getSlot(slotNumber, validatorAddress) {
        let data = await this.querySlot([slotNumber]);
        if (!data) return {
            slot: slotNumber,
            tips: 0,
            skipped: false,
            transaction_fee: 0,
            priority_fee: 0,
            success_transactions: 0,
            failed_transactions: 0
        };
        data = data.allData[0];

        await this.updateValidatorTips(validatorAddress, slotNumber, data?.tips || 0, this.currentEpoch);

        return {
            slot: data.slot,
            tips: data.tips / 1e9,
            skipped: data.skipped,
            transaction_fee: data.transaction_fee / 1e9,
            priority_fee: data.priority_fee / 1e9,
            success_transactions: data.success_nonvote_transaction_cnt,
            failed_transactions: data.failed_nonvote_transaction_cnt
        };
    }

    async extractFeesAndTips(slot, validatorAddress) {
        const slotData = await this.getSlot(slot, validatorAddress);
        if (!slotData) return { feesEarned: 0, tips: 0, transactionCount: 0 };

        const feesEarned = slotData.transaction_fee + slotData.priority_fee;
        const tips = slotData?.tips || 0;
        const transactionCount = slotData.success_transactions + slotData.failed_transactions;

        return { feesEarned, tips, transactionCount };
    }

    async updateValidatorTips(validatorAddress, slot, tipsLamports, currentEpoch) {
        try {
            const tipsSOL = tipsLamports / 1e9;
            const updateResult = await validatorTips.findOneAndUpdate(
                {
                    validatorAddress: validatorAddress,
                    'epochs.epochNumber': currentEpoch
                },
                {
                    $inc: {
                        'epochs.$.totalTipsSOL': tipsSOL,
                        'epochs.$.totalTipsLamports': tipsLamports,
                        'epochs.$.blockCount': 1
                    },
                    $push: {
                        'epochs.$.blocks': {
                            slot: slot,
                            tipsSOL: tipsSOL,
                            tipsLamports: tipsLamports,
                            blockTime: new Date()
                        }
                    },
                    $set: {
                        lastUpdated: new Date()
                    }
                },
                { new: true }
            );

            if (!updateResult) {
                await validatorTips.findOneAndUpdate(
                    { validatorAddress: validatorAddress },
                    {
                        $push: {
                            epochs: {
                                epochNumber: currentEpoch,
                                totalTipsSOL: tipsSOL,
                                totalTipsLamports: tipsLamports,
                                blockCount: 1,
                                epochStartDate: new Date(),
                                blocks: [{
                                    slot: slot,
                                    tipsSOL: tipsSOL,
                                    tipsLamports: tipsLamports,
                                    blockTime: new Date()
                                }]
                            }
                        },
                        $set: {
                            lastUpdated: new Date()
                        }
                    },
                    {
                        upsert: true,
                        new: true
                    }
                );
            }

            
            await validatorTips.updateOne(
                { validatorAddress: validatorAddress },
                {
                    $push: {
                        epochs: {
                            $each: [],
                            $sort: { epochNumber: -1 },
                            $slice: 10
                        }
                    }
                }
            );
        } catch (error) {
            console.error('Error updating validator tips:', error);
            throw error;
        }
    }

    async getCurrentEpochTips(validatorAddress, currentEpoch = null) {
        try {
            if (!currentEpoch) {
                currentEpoch = this.currentEpoch;
            }
            const validator = await validatorTips.findOne(
                { validatorAddress: validatorAddress },
                { epochs: { $elemMatch: { epochNumber: currentEpoch } } }
            );

            if (validator && validator.epochs.length > 0) {
                return validator.epochs[0];
            }

            return {
                epochNumber: currentEpoch,
                totalTipsSOL: 0,
                totalTipsLamports: 0,
                blockCount: 0
            };
        } catch (error) {
            console.error('Error getting current epoch tips:', error);
            return null;
        }
    }

    lamportsToSol(lamports) {
        return (parseFloat(lamports) / 1_000_000_000).toFixed(9);
    }

    generateRequestId() {
        return Date.now() + "-" + Math.random().toString(36).slice(2);
    }

    async querySlot(slots) {
        return new Promise((resolve, reject) => {
            const requestId = this.generateRequestId();

            pendingRequests.set(requestId, {
                pendingSlots: new Set(slots),
                data: [],
                totalTips: 0,
                totalFees: 0,
                resolve,
                reject
            });

            for (const slot of slots) {
                ws.send(JSON.stringify({
                    topic: "slot",
                    key: "query",
                    id: slot,
                    params: { slot }
                }));
            }

            setTimeout(() => {
                if (pendingRequests.has(requestId)) {
                    const req = pendingRequests.get(requestId);
                    pendingRequests.delete(requestId);
                    req.resolve({
                        allData: req.data,
                        totalTips: req.totalTips,
                        totalFees: req.totalFees
                    });
                }
            }, 5000);
        });
    }

    async processValidatorBlock(slot, validatorAddress) {
        
        const [block, slotData] = await Promise.all([
            this.getBlockDetails(slot),
            this.extractFeesAndTips(slot, validatorAddress)
        ]);
        
        if (!block) return null;

        const { feesEarned, tips, transactionCount } = slotData;
        const totalEarnings = feesEarned + tips;

        

        return {
            slot: slot,
            validator: validatorAddress,
            blockHeight: block.blockHeight,
            blockTime: block.blockTime ? new Date(block.blockTime * 1000).toISOString() : 'N/A',
            feesEarned: feesEarned,
            feesEarnedUSD: this.solToUSD(feesEarned),
            tips: tips,
            tipsUSD: this.solToUSD(tips),
            totalEarnings: totalEarnings,
            totalEarningsUSD: this.solToUSD(totalEarnings),
            totalTransactions: transactionCount || 0,
            parentSlot: block.parentSlot,
            timestamp: new Date().toISOString()
        };
    }

    async displayBlocksTable(blocks, validator) {
        if (!blocks?.length) return;

        const sortedBlocks = blocks.sort((a, b) => b.slot - a.slot);
        let desc = "";

        sortedBlocks.forEach(block => {
            const slot = block.slot.toString();

            desc += `[\`${slot}\`](https://solana.fm/block/${slot}?cluster=mainnet-alpha)\n**Fees:** <:sol:1397286031593705512> ${parseFloat(block.feesEarned).toFixed(3)} ($${block.feesEarnedUSD})\n**Tips:** <:sol:1397286031593705512> ${parseFloat(block.tips).toFixed(3)} ($${block.tipsUSD})\n\n`;
        });

        const nextSlotData = await this.getNextValidatorSlotData(validator, sortedBlocks[0].slot);

        const voteAccounts = await this.getVoteAccounts();
        const allAccounts = [...voteAccounts.current, ...voteAccounts.delinquent];
        const validatorAccount = allAccounts.find(account => account.nodePubkey === nextSlotData.validator.trim());

        const currentEpochEarnings = await this.getEarnedCurrentEpoch(validatorAccount.votePubkey);
        const currentEpochTips = await this.getCurrentEpochTips(validator);
        const mevCommission = parseFloat(currentEpochEarnings.mevCommission);

        const totalFeesSOL = sortedBlocks.reduce((sum, block) => sum + block.feesEarned, 0);
        const totalTipsSOL = sortedBlocks.reduce((sum, block) => sum + block.tips, 0);
        const totalEarnings = totalFeesSOL + (totalTipsSOL * mevCommission);
        const totalTxs = sortedBlocks.reduce((sum, block) => sum + block.totalTransactions, 0);

        const leaderRewards = currentEpochEarnings.leaderRewards + totalFeesSOL

        const validatorData = await this.getValidatorData(validatorAccount.votePubkey, this.currentEpoch);
        const info = validatorData?.valiStats || {};

        const nextTimeinMS = Math.floor((Date.now() + nextSlotData.msUntilNext) / 1000);

        const container = new ContainerBuilder();

        const text = new TextDisplayBuilder()
            .setContent(`### New Leader Slot for [${info.name}](https://solscan.io/account/${validatorAccount.votePubkey})`);

        container.addTextDisplayComponents(text);

        const section2 = new SectionBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(desc)
            )
            .setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(info.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
            )

        container.addSectionComponents(section2);
        container.addSeparatorComponents(separator => separator.setSpacing(SeparatorSpacingSize.Large));
        
        let extraEmoji = "";
        const totalEarningsUSD = this.solToUSD(totalEarnings);
        if(totalEarningsUSD > 50)  extraEmoji = "\`👑\` ";

        const text2 = new TextDisplayBuilder()
            .setContent([
                `**Total Fees:** <:sol:1397286031593705512> ${totalFeesSOL.toFixed(4)} ($${this.solToUSD(totalFeesSOL)})`,
                `**Tips Earned (MEV: ${mevCommission * 100}%):** <:sol:1397286031593705512> ${(totalTipsSOL * mevCommission).toFixed(4)} ($${this.solToUSD((totalTipsSOL * mevCommission))})`,
                `\`🏆\` ${extraEmoji}**Total Earnings:** <:sol:1397286031593705512> ${totalEarnings.toFixed(4)} ($${this.solToUSD(totalEarnings)})`,
                `\`⏱️\` **Next Slot:** ${nextSlotData.hasNextSlot ? `<t:${nextTimeinMS}:R>` : "N/A"}`
            ].join("\n"));

        container.addTextDisplayComponents(text2);
        container.addSeparatorComponents(separator => separator.setSpacing(SeparatorSpacingSize.Small));

        const text3 = new TextDisplayBuilder()
            .setContent([
                `### \`🟩\` **Current Epoch Stats (${this.currentEpoch})**`,
                `> **Leader Rewards:** <:sol:1397286031593705512> ${leaderRewards.toFixed(2)} ($${this.solToUSD(leaderRewards)})`,
                `> **Tips Earned (est.):** <:sol:1397286031593705512> ${(currentEpochTips.totalTipsSOL * mevCommission).toFixed(3)} ($${this.solToUSD((currentEpochTips.totalTipsSOL * mevCommission))})`,
                `> **Voting Cost:** <:sol:1397286031593705512> -${currentEpochEarnings.votingFees.toFixed(2)} (-$${this.solToUSD(currentEpochEarnings.votingFees)})`,
                `> **TVC Rank/Credits:** #${info.tvcRank}/${info.tvCredits}`,
                `-# ${totalTxs.toLocaleString()} TXs | ${info.leaderSlotsDone + 4}/${info.leaderSlotsEpoch}`
            ].join("\n"))

        container.addTextDisplayComponents(text3);


        const trackedChannels = await validatorSubscriptionSchema.find({
            validatorAddress: validator
        });

        if (trackedChannels.length === 0) {
            console.log(`⚠️ No channels found tracking validator ${validator}`);
            return;
        }

        const messagePromises = [];
        const invalidChannels = [];

        for (const subscription of trackedChannels) {
            for (const sub of subscription.subscriptions) {
                if (sub.updatingStatus.status) {
                    this.emit('blocksUpdated', validator, validatorAccount.votePubkey, sub);
                }
                if (sub.normalStatus) {
                    const channel = client.channels.cache.get(sub.channelId);
                    if (channel) {
                        messagePromises.push(
                            channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 })
                                .catch(error => {
                                    console.error(`❌ Error sending to channel ${sub.channelId}:`, error.message);
                                    if (error.code === 50001 || error.code === 50013) { // Missing access or missing permissions
                                        invalidChannels.push({ subscriptionId: subscription._id, channelId: sub.channelId });
                                    }
                                })
                        );
                    } else {
                        console.log(`⚠️ Channel ${sub.channelId} not found or bot doesn't have access`);
                        invalidChannels.push({ subscriptionId: subscription._id, channelId: sub.channelId });
                    }
                }
            }
        }

        
        if (messagePromises.length > 0) {
            await Promise.allSettled(messagePromises);
        }

        
        if (invalidChannels.length > 0) {
            for (const { subscriptionId, channelId } of invalidChannels) {
                await this.cleanupSubscription(subscriptionId, channelId, false);
            }
        }

    }

    addToBatch(validator, blockInfo) {
        if (!this.pendingBlocks.has(validator)) {
            this.pendingBlocks.set(validator, []);
        }

        const batch = this.pendingBlocks.get(validator);
        
        
        const isDuplicate = batch.some(block => block.slot === blockInfo.slot);
        if (isDuplicate) {
            console.log(`[BATCH] Duplicate slot ${blockInfo.slot} detected, skipping`);
            return;
        }

        batch.push(blockInfo);
        const batchSize = batch.length;
        const batchSlots = batch.map(b => b.slot).join(', ');
        
        console.log(`[BATCH] ${validator.substring(0, 8)}... now has ${batchSize} slots: [${batchSlots}]`);

        if (batchSize === 4) {
            console.log(`[BATCH] ✅ Sending batch of 4 for ${validator.substring(0, 8)}...`);
            if (this.batchTimeouts.has(validator)) {
                clearTimeout(this.batchTimeouts.get(validator));
                this.batchTimeouts.delete(validator);
            }
            this.displayBatch(validator);
            return;
        }

        if (this.batchTimeouts.has(validator)) {
            clearTimeout(this.batchTimeouts.get(validator));
            console.log(`[BATCH] ⏱️ Resetting timeout for ${validator.substring(0, 8)}...`);
        }

        this.batchTimeouts.set(validator, setTimeout(() => {
            console.log(`[BATCH] ⏰ Timeout fired! Sending ${batchSize} slots for ${validator.substring(0, 8)}...`);
            this.displayBatch(validator);
        }, 8000));
    }

    async displayBatch(validator) {
        const blocks = this.pendingBlocks.get(validator);
        if (!blocks?.length) return;

        await this.displayBlocksTable(blocks, validator);
        this.pendingBlocks.set(validator, []);
        this.batchTimeouts.delete(validator);
    }

    async displayAllPendingBatches() {
        const promises = [];
        this.pendingBlocks.forEach((blocks, validator) => {
            if (this.batchTimeouts.has(validator)) {
                clearTimeout(this.batchTimeouts.get(validator));
            }
            promises.push(this.displayBatch(validator));
        });
        await Promise.all(promises);
    }

    getNextValidatorSlot(validatorAddress, currentSlot, epochInfo) {
        if (!this.leaderSchedule[validatorAddress]) return null;

        const validatorSlots = this.leaderSchedule[validatorAddress];
        const currentRelativeSlot = currentSlot - epochInfo.absoluteSlot + epochInfo.slotIndex;
        const nextRelativeSlot = validatorSlots.find(slot => slot > currentRelativeSlot);

        if (nextRelativeSlot !== undefined) {
            return epochInfo.absoluteSlot - epochInfo.slotIndex + nextRelativeSlot;
        }
        return null;
    }

    calculateTimeToNextSlot(currentSlot, nextSlot) {
        if (!nextSlot) return null;
        const SLOT_TIME_MS = 400;
        const slotsUntilNext = nextSlot - currentSlot;
        const msUntilNext = slotsUntilNext * SLOT_TIME_MS;
        const nextSlotTime = new Date(Date.now() + msUntilNext);

        return {
            nextSlot,
            slotsUntilNext,
            msUntilNext,
            nextSlotTime,
            nextSlotTimeString: nextSlotTime.toLocaleTimeString()
        };
    }

    async getNextValidatorSlotData(validator, latestSlot) {
        try {
            const currentSlot = await this.connection.getSlot('confirmed');
            const epochInfo = await this.getEpochInfo('confirmed');
            const nextSlot = this.getNextValidatorSlot(validator, currentSlot, epochInfo);

            if (nextSlot) {
                const timing = this.calculateTimeToNextSlot(currentSlot, nextSlot);
                return {
                    validator,
                    nextSlot: timing.nextSlot,
                    slotsUntilNext: timing.slotsUntilNext,
                    estimatedTime: timing.nextSlotTimeString,
                    estimatedTime: timing.nextSlotTimeString,
                    timeUntilNext: this.formatDuration(timing.msUntilNext),
                    msUntilNext: timing.msUntilNext,
                    isComingSoon: timing.msUntilNext < 30000,
                    hasNextSlot: true
                };
            } else {
                return {
                    validator,
                    hasNextSlot: false,
                    epochInfo: {
                        currentEpoch: epochInfo.epoch,
                        slotsRemaining: epochInfo.slotsInEpoch - epochInfo.slotIndex
                    }
                };
            }
        } catch (error) {
            return {
                validator,
                hasNextSlot: false,
                error: error.message
            };
        }
    }

    formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${Math.ceil(ms / 1000)} seconds`;
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.ceil((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    async monitorForNewBlocks() {
        if (!this.isMonitoring || this.isProcessing) return;

        this.isProcessing = true;
        try {
            const currentSlot = await this.connection.getSlot('confirmed');

            if (currentSlot > this.lastCheckedSlot) {
                const epochInfo = await this.getEpochInfo('confirmed');
                if (epochInfo.epoch !== this.currentEpoch) { 
                    await this.updateLeaderSchedule(currentSlot);
                    
                    logStream.end();
                    fs.renameSync("./slotsData/slot-current.jsonl", `./slotsData/slot-${this.currentEpoch - 1}.jsonl`);
                    logStream = fs.createWriteStream("./slotsData/slot-current.jsonl", { flags: "a" });

                    setTimeout(async () => {
                        await this.epochEnd(epochInfo);
                    }, 30 * 60 * 1000)
                }

                const newSlots = [];
                for (let slot = this.lastCheckedSlot + 1; slot <= currentSlot; slot++) {
                    if (this.processedSlots.has(slot)) {
                        console.log(`[SKIP] Slot ${slot} already processed`);
                        continue;
                    }

                    const targetValidator = this.isTargetValidatorSlot(slot, epochInfo);
                    if (targetValidator) {
                        console.log(`[NEW SLOT] Found validator slot ${slot} for ${targetValidator.substring(0, 8)}...`);
                        newSlots.push({ slot, validator: targetValidator });
                        this.processedSlots.add(slot);
                    }
                }

                this.lastCheckedSlot = currentSlot;

                
                if (newSlots.length > 0) {
                    await this.fetchSOLPrice();
                }

                
                const blockPromises = newSlots.map(async ({ slot, validator }) => {
                    try {
                        const startTime = Date.now();
                        const blockInfo = await this.processValidatorBlock(slot, validator);
                        const processingTime = Date.now() - startTime;
                        console.log(`[PROCESSING] Slot ${slot} took ${processingTime}ms to process`);
                        return { blockInfo, validator };
                    } catch (error) {
                        console.error(`Error processing slot ${slot}:`, error);
                        return null;
                    }
                });

                const results = await Promise.all(blockPromises);
                
                console.log(`[DEBUG] Processed ${results.length} slots, successful: ${results.filter(r => r?.blockInfo).length}`);
                
                
                for (const result of results) {
                    if (result?.blockInfo) {
                        console.log(`[DEBUG] Adding slot ${result.blockInfo.slot} to batch for ${result.validator.substring(0, 8)}`);
                        this.addToBatch(result.validator, result.blockInfo);
                    } else if (result) {
                        console.log(`[DEBUG] Slot processing returned null (possibly skipped)`);
                    }
                }

                
            }
        } catch (error) {
            if (error.message.includes('429')) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.error('Error in monitoring loop:', error);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    async startMonitoring(intervalMs = 2000) {
        if (this.isMonitoring) return;

        console.log('🎬 Starting continuous monitoring...');
        this.isMonitoring = true;
        await this.monitorForNewBlocks();
        this.monitoringInterval = setInterval(async () => {
            await this.monitorForNewBlocks();

            if (ws) ws.send(JSON.stringify({ "topic": "summary", "key": "ping", "id": 1 }));
        }, intervalMs);
    }

    async stopMonitoring() {
        if (!this.isMonitoring) return;

        this.isMonitoring = false;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
        }
        await this.displayAllPendingBatches();
    }

    async cleanupSubscription(subscriptionId, channelOrUserId, isDM = false) {
        const schema = isDM ? validatorDMSubscriptionSchema : validatorSubscriptionSchema;
        const pullField = isDM ? 'subscribers' : 'subscriptions';
        const matchField = isDM ? 'userId' : 'channelId';
        
        const result = await schema.findOneAndUpdate(
            { _id: subscriptionId },
            { $pull: { [pullField]: { [matchField]: channelOrUserId } } },
            { new: true }
        );
        
        
        if (result && (!result[pullField] || result[pullField].length === 0)) {
            await schema.deleteOne({ _id: subscriptionId });
            console.log(`🗑️ Deleted ${isDM ? 'DM' : 'channel'} subscription ${subscriptionId} - no ${isDM ? 'subscribers' : 'channels'} remaining`);
            return { deleted: true, validatorAddress: result.validatorAddress };
        } else {
            console.log(`🧹 Removed invalid ${isDM ? 'user' : 'channel'} ${channelOrUserId} from subscription ${subscriptionId}`);
            return { deleted: false };
        }
    }

    async getValidatorLeaderSlots(validatorIdentity, targetEpoch, { onlyPast = true } = {}) {
        const epochSchedule = await this.connection.getEpochSchedule();
        const epochInfo = await this.getEpochInfo("finalized");

        const firstSlotEpoch = epochInfo.epoch * epochSchedule.slotsPerEpoch;

        let leaderSchedule = await import(`./scheduleData/schedule-${targetEpoch}.json`, { assert: { type: 'json' } });

        leaderSchedule = leaderSchedule.default[validatorIdentity];

        const leaderSlots = [];

        for (let i = 0; i < leaderSchedule.length; i++) {
            const slot = firstSlotEpoch + leaderSchedule[i];
            if (onlyPast && slot > epochInfo.slot) continue;
            leaderSlots.push(slot);
        }

        return leaderSlots;
    }

    async getValidatorStakeInfo(validatorHistoryData, currentEpoch) {
        const currentEpochData = validatorHistoryData.filter(x => x.epoch === currentEpoch);
        const currentStake = parseFloat(currentEpochData[0].totalStake);

        const previousEpochData = validatorHistoryData.filter(x => x.epoch === currentEpoch - 1);
        const previousStake = parseFloat(previousEpochData[0].totalStake);

        const change = ((currentStake - previousStake) / previousStake) * 100;
        const changeAmount = currentStake - previousStake;

        return {
            changeAmount: changeAmount / 1e9,
            changePercentage: change
        }
    }

    async waitForValidatorData(validatorVoteAddress, targetEpoch, mevCommission) {
        while (true) {
            try {
                const res = await fetch(`https://api.thevalidators.io/validators-history/history?network=mainnet&vote_id=${validatorVoteAddress}&epoch_count=1000&epoch_from=${targetEpoch}`);
                const data = await res.json();
                const epochData = data.data.find(item => item.epoch === targetEpoch - 1);

                if (epochData && mevCommission > 0 && epochData.jitoReward > 0) {
                    console.log(`✅ Criteria met for ${validatorVoteAddress}`);
                    return data;
                } else if (mevCommission <= 0) {
                    return data;
                }

                console.log(`⏳ Waiting for data for ${validatorVoteAddress}...`);
            } catch (err) {
                console.error(`⚠️ Error fetching data for ${validatorVoteAddress}:`, err.message);
            }

            
            await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        }
    }

    async getEarnedLastEpoch(validatorAddress, epoch) {
        const raw = fs.readFileSync(`./slotsData/slot-${epoch}.jsonl`, 'utf8').trim();
        const slotIndex = new Map(
            raw.length === 0
                ? []
                : raw.split('\n').map(line => {
                    const o = JSON.parse(line);
                    return [o.slot, o];
                })
        );

        const scheduleMod = await import(`./scheduleData/schedule-${epoch}.json`, {
            assert: { type: 'json' }
        });
        const schedule = scheduleMod.default;
        const relativeSlots = schedule[validatorAddress] || [];
        if (relativeSlots.length === 0) {
            return { totalFeesEarned: 0, totalTipsEarned: 0 };
        }

        const info = await this.getEpochInfo('confirmed');
        const es = await this.connection.getEpochSchedule();

        let firstSlotInEpoch;
        if (epoch === info.epoch) {
            firstSlotInEpoch = info.absoluteSlot - info.slotIndex;
        } else {
            const currentFirst = info.absoluteSlot - info.slotIndex;
            const delta = info.epoch - epoch;
            firstSlotInEpoch = currentFirst - delta * es.slotsPerEpoch;
        }

        const absoluteSlots = relativeSlots.map(i => firstSlotInEpoch + i);
        const missing = absoluteSlots.filter(s => !slotIndex.has(s));

        if (missing.length > 0) {
            try {
                const result = await this.querySlot(missing);
                const arr = result?.allData;
                if (Array.isArray(arr) && arr.length) {
                    for (let i = 0; i < arr.length; i++) {
                        const d = arr[i];
                        slotIndex.set(d.slot, {
                            slot: d.slot,
                            mine: d.mine ?? false,
                            skipped: d.skipped ?? false,
                            duration_nanos: d.duration_nanos,
                            completed_time_nanos: String(d.completed_time_nanos ?? ''),
                            level: d.level ?? 'completed',
                            success_nonvote_transaction_cnt: d.success_nonvote_transaction_cnt ?? 0,
                            failed_nonvote_transaction_cnt: d.failed_nonvote_transaction_cnt ?? 0,
                            success_vote_transaction_cnt: d.success_vote_transaction_cnt ?? 0,
                            failed_vote_transaction_cnt: d.failed_vote_transaction_cnt ?? 0,
                            max_compute_units: d.max_compute_units,
                            compute_units: d.compute_units,
                            transaction_fee: String(d.transaction_fee ?? 0),
                            priority_fee: String(d.priority_fee ?? 0),
                            tips: String(d.tips ?? 0),
                        });
                    }
                }
            } catch { }
        }

        let totalFeesLamports = 0;
        let totalPriorityLamports = 0;
        let totalTipsLamports = 0;

        for (let i = 0; i < absoluteSlots.length; i++) {
            const row = slotIndex.get(absoluteSlots[i]);
            if (!row) continue;
            totalFeesLamports += Number(row.transaction_fee || 0);
            totalPriorityLamports += Number(row.priority_fee || 0);
            totalTipsLamports += Number(row.tips || 0);
        }

        return {
            totalFeesEarned: (totalFeesLamports + totalPriorityLamports) / 1e9,
            totalTipsEarned: totalTipsLamports / 1e9
        };
    }

    async getVaultFees(epoch, voteAddress, valiMEV, valiComm) {
        try {
            const latestFileResponse = await fetch(`https://raw.githubusercontent.com/SolanaVault/stakebot-data/refs/heads/main/${epoch}/epoch-stats-latest.txt`);
            if (!latestFileResponse.ok) {
                throw new Error(`Failed to fetch latest file name: ${latestFileResponse.status}`);
            }
            const latestFile = await latestFileResponse.text();
            const fileName = latestFile.trim();

            const validatorTargetsResponse = await fetch(`https://raw.githubusercontent.com/SolanaVault/stakebot-data/refs/heads/main/${epoch}/${fileName}`);
            if (!validatorTargetsResponse.ok) {
                throw new Error(`Failed to fetch validator targets: ${validatorTargetsResponse.status}`);
            }
            const validatorTargetsData = await validatorTargetsResponse.json();

            const matchingValidator = validatorTargetsData.validatorTargets?.find(
                validator => validator.votePubkey === voteAddress
            );

            if (!matchingValidator) {
                console.log(`No matching validator found for vote address: ${voteAddress}`);
                return 0;
            }

            const undirectedWhitelist = parseFloat(matchingValidator.targetStake?.undirectedWhitelist || 0);
            if (undirectedWhitelist <= 0) {
                console.log(`Validator ${voteAddress} has no undirected whitelist stake`);
                return 0;
            }

            const aggregateDataResponse = await fetch('https://api.trillium.so/ten_epoch_aggregate_data');
            if (!aggregateDataResponse.ok) {
                throw new Error(`Failed to fetch aggregate data: ${aggregateDataResponse.status}`);
            }
            const aggregateData = await aggregateDataResponse.json();

            const inflationRate = await this.connection.getInflationRate();
            const chainInflationRate = parseFloat(inflationRate.total || 0);

            const avgMevPerBlock = parseFloat(aggregateData.avg_mev_per_block || 0);
            const avgRewardsPerBlock = parseFloat(aggregateData.avg_rewards_per_block || 0);
            const avgStakePerLeaderSlot = parseFloat(aggregateData.avg_stake_per_leader_slot || 0);
            const epochsPerYear = parseFloat(aggregateData.epochs_per_year || 0);

            const stakeByVault = undirectedWhitelist / 1e9;

            console.log(
                `avgMevPerBlock: ${avgMevPerBlock}`,
                `valiMEV: ${valiMEV}`,
                `avgRewardsPerBlock: ${avgRewardsPerBlock}`,
                `stakeByVault: ${stakeByVault}`,
                `avgStakePerLeaderSlot: ${avgStakePerLeaderSlot}`,
                `chainInflationRate (from RPC): ${chainInflationRate}`,
                `epochsPerYear: ${epochsPerYear}`,
                `valiComm: ${valiComm}`
            )

            const mevComponent = (avgMevPerBlock * valiMEV) + avgRewardsPerBlock;
            const stakeRatio = stakeByVault / avgStakePerLeaderSlot;
            const inflationComponent = stakeByVault * (chainInflationRate / epochsPerYear) * valiComm;
            
            const totalFees = (mevComponent * stakeRatio + inflationComponent) * 0.25;

            console.log(`Vault fees calculated for ${voteAddress}: ${totalFees.toFixed(6)} SOL`);
            return totalFees;

        } catch (error) {
            console.error(`Error calculating vault fees for ${voteAddress}:`, error);
            return 0;
        }
    }

    async get2ZFees(validatorAddress, leaderRewards) {
        let data = await fetch(`https://www.validators.app/api/v1/validators/mainnet/${validatorAddress}.json`, {
            headers: {
                'Token': process.env.validatorsAppApi
            }
        })
        data = await data.json();
        console.log(data, "VALIDATOR DATA FOR DZ");
        if(data.is_dz) {
            return (leaderRewards * 0.05).toFixed(2);
        } else {
            return 0
        }
    }

    async epochEnd(currentEpochInfo) {
        console.log(`Epoch ${currentEpochInfo.epoch - 1} ended.`);
        
        await loadValidatorLists();

        
        const epochSchedule = await this.connection.getLeaderSchedule();

        fs.writeFileSync(`./scheduleData/schedule-${currentEpochInfo.epoch}.json`, JSON.stringify(epochSchedule, null, 2));

        
        if (fs.existsSync(`./scheduleData/schedule-${currentEpochInfo.epoch - 3}.json`)) {
            fs.unlinkSync(`./scheduleData/schedule-${currentEpochInfo.epoch - 3}.json`);
        }

        
        try {
            const allSubscriptions = await validatorDMSubscriptionSchema.find();

            for (const sub of allSubscriptions) {
                const validatorVoteAddress = sub.validatorVoteAddress;

            
                const response = await fetch(`https://api.thevalidators.io/validators-history/history?network=mainnet&vote_id=${validatorVoteAddress}&epoch_count=1000&epoch_from=${currentEpochInfo.epoch}`);
                const data = await response.json();
                const epochData = data.data.find(item => item.epoch === currentEpochInfo.epoch - 1);

                let jitoData = await fetch(`https://api.jpool.one/validators?fields=apy,is_jito,jito_apy,node_ip,jito_commission_bps,skip_rate,uptime&vote=${validatorVoteAddress}`);
                jitoData = await jitoData.json();

                
                

                let currentEpochData = await fetch(`https://api.thevalidators.io/validators/list?network=mainnet&select=voteId,validatorId,slotIndex,leaderSlotsTotal,leaderSlotsDone,leaderSlotsEpoch,fee,totalStake&vote_id=${validatorVoteAddress}`)
                currentEpochData = await currentEpochData.json();
                currentEpochData = currentEpochData.data[0]

                const stakeInfo = await this.getValidatorStakeInfo(data.data, currentEpochInfo.epoch);
                const mevCommission = epochData.mevCommission / 100;
                const totalEarnings = parseFloat(epochData.votingReward) - parseFloat(epochData.votingFee) + parseFloat(epochData.commissionReward) + parseFloat(epochData.jitoReward) + parseFloat(epochData.votingCompensation);

                const validatorList = getMainnetList();
                const basicInfo = validatorList.find(item => item.voteId === validatorVoteAddress);

                const votingFeeSol = (epochData.votingFee / 1e9);
                const votingRewardSol = (epochData.votingReward / 1e9);
                const commissionRewardSol = (epochData.commissionReward / 1e9);
                const votingCompensationSol = (epochData.votingCompensation / 1e9);
                const totalEarningsSol = (totalEarnings / 1e9);

                const votingFeeUsd = this.solToUSD(votingFeeSol);
                const votingRewardUsd = this.solToUSD(votingRewardSol);
                const commissionRewardUsd = this.solToUSD(commissionRewardSol);
                const votingCompensationUsd = this.solToUSD(votingCompensationSol);
                const totalEarningsUsd = this.solToUSD(totalEarningsSol);

                let vaultData = "";
                const vaultFees = await this.getVaultFees(currentEpochInfo.epoch - 1, validatorVoteAddress, mevCommission/100, epochData.fee/100);
                if(vaultFees > 0) {
                    vaultData = `<:thevault:1420867315141968063> **Vault Fees:** <:sol:1397286031593705512> ${vaultFees.toFixed(2)} ($${this.solToUSD(vaultFees)})`;
                }
                let dzData = "";
                const dzFees = await this.get2ZFees(sub.validatorAddress, votingRewardSol);
                console.log(dzFees, "DZ FEES");
                if(dzFees > 0) {
                    dzData = `<:doublezero:1422326611230851093> **DZ Fees:** <:sol:1397286031593705512> ${dzFees.toFixed(2)} ($${this.solToUSD(dzFees)})`;
                }
                const epochInfo = await this.getEpochInfo();
                const nextEpoch = epochInfo.epoch + 1;
                const firstSlotNextEpoch = nextEpoch * 432000;
                
                const url = process.env.rpcUrl;
                const options = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: `{"jsonrpc":"2.0","id":"1","method":"getLeaderSchedule","params":[${firstSlotNextEpoch},{"identity":"${sub.validatorAddress}","commitment":"processed"}]}`
                };
                let slotsNextEpoch = await fetch(url, options);
                slotsNextEpoch = await slotsNextEpoch.json();
                slotsNextEpoch = slotsNextEpoch.result[sub.validatorAddress].length

                const { totalFeesEarned, totalTipsEarned } = await this.getEarnedLastEpoch(sub.validatorAddress, currentEpochInfo.epoch - 1);
                const changeEmoji = stakeInfo.changePercentage > 0 ? '<:up:1401299682138783866>' : '<:down:1401299702661644378>'
                const changeSymbol = stakeInfo.changePercentage > 0 ? '+' : '';

                const skipped = epochData.leaderSlotsTotal - epochData.leaderSlotsDone > 0 ? epochData.leaderSlotsTotal - epochData.leaderSlotsDone : 0;

                const container = new ContainerBuilder();

                const text = new TextDisplayBuilder()
                    .setContent(`### Epoch Change: ${currentEpochInfo.epoch - 1} → ${currentEpochInfo.epoch}`);

                container.addTextDisplayComponents(text);

                const text2 = new TextDisplayBuilder()
                    .setContent(`
**Name:** [${basicInfo.name}](https://solscan.io/account/${validatorVoteAddress})
**Leader Slots:** ${epochData.leaderSlotsDone}/${epochData.leaderSlotsTotal} ${skipped > 0 ? `(${skipped} skipped)` : ''}
**Slots This Epoch:** ${currentEpochData.leaderSlotsEpoch}
**Slots Next Epoch:** ${slotsNextEpoch}
**Active Stake:** <:sol:1397286031593705512> ${(parseFloat(currentEpochData.totalStake) / 1e9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ($${Number(this.solToUSD(this.lamportsToSol(currentEpochData.totalStake))).toLocaleString(undefined, { maximumFractionDigits: 0 })})
**Stake Change:** ${changeEmoji}${stakeInfo.changePercentage.toFixed(0)}% (<:sol:1397286031593705512> ${changeSymbol}${stakeInfo.changeAmount.toFixed(2).toLocaleString()}) 
`);

                const section2 = new SectionBuilder()
                    .addTextDisplayComponents(text2)
                    .setThumbnailAccessory(
                        new ThumbnailBuilder()
                            .setURL(basicInfo.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
                    );

                container.addSectionComponents(section2);
                container.addSeparatorComponents(separator => separator.setSpacing(SeparatorSpacingSize.Small));
                const text3 = new TextDisplayBuilder()
                    .setContent(`
**Leader Rewards:** <:sol:1397286031593705512> ${votingRewardSol.toFixed(2)} ($${votingRewardUsd})
**Commission (${epochData.fee}%):** <:sol:1397286031593705512> ${commissionRewardSol.toFixed(2)} ($${commissionRewardUsd})
**Total Tips (${mevCommission}%):** <:sol:1397286031593705512> ${(totalTipsEarned.toFixed(2) * (mevCommission / 100)).toFixed(2)} ($${Number(this.solToUSD(totalTipsEarned * (mevCommission / 100))).toFixed(2)})
**Voting Fees:** <:sol:1397286031593705512> -${votingFeeSol.toFixed(2)} (-$${votingFeeUsd})
**Compensation:** <:sol:1397286031593705512> ${votingCompensationSol.toFixed(2)} ($${votingCompensationUsd})${vaultFees > 0 ? `\n${vaultData}\n` : ''}${dzData}

\`🏆\` **Total Earnings:** <:sol:1397286031593705512> ${totalEarningsSol.toFixed(2)} ($${totalEarningsUsd.toLocaleString()})
`);

                container.addTextDisplayComponents(text3);
                
                // Batch DM sending for better performance
                const dmPromises = [];
                const failedUsers = [];
                
                for (const user of sub.subscribers) {
                    dmPromises.push(
                        client.users.fetch(user.userId)
                            .then(dmUser => {
                                if (dmUser) {
                                    return dmUser.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
                                } else {
                                    failedUsers.push({ subscriptionId: sub._id, userId: user.userId, reason: 'User not found' });
                                }
                            })
                            .catch(err => {
                                console.error(`Failed to DM user ${user.userId}:`, err.message);
                                
                                if (err.code === 50007 || err.code === 10013) {
                                    failedUsers.push({ subscriptionId: sub._id, userId: user.userId, reason: err.message });
                                }
                            })
                    );
                }
                
                
                if (dmPromises.length > 0) {
                    await Promise.allSettled(dmPromises);
                }
                
                
                if (failedUsers.length > 0) {
                    for (const { subscriptionId, userId, reason } of failedUsers) {
                        await this.cleanupSubscription(subscriptionId, userId, true);
                        console.log(`Reason: ${reason}`);
                    }
                }
            }



        } catch (error) {
            console.log(error)
            const dmUser = await client.users.fetch("746376407059398667");
            dmUser.send({ content: `Error: ${error}` });
        }

    }
}

const monitor = new SolanaContinuousValidatorMonitor();

async function main() {
    try {
        await monitor.connectWebSocket();
        let currentValidators = await validatorSubscriptionSchema.find({}).select('validatorAddress');
        let validatorAddresses = [...new Set(currentValidators.map(v => v.validatorAddress))];

        await monitor.initialize(validatorAddresses);

        setInterval(async () => {
            try {
                const updatedValidators = await validatorSubscriptionSchema.find({});
                const newAddresses = [...new Set(updatedValidators.map(v => v.validatorAddress))];

                if (JSON.stringify(newAddresses.sort()) !== JSON.stringify(validatorAddresses.sort())) {
                    console.log(`🔄 Validator list updated: ${validatorAddresses.length} → ${newAddresses.length}`);

                    validatorAddresses = newAddresses;
                    monitor.validatorAddresses = newAddresses;
                    await monitor.updateLeaderSchedule();
                }
            } catch (error) {
                console.error('Error checking for validator updates:', error);
            }
        }, 5000);
        await monitor.startMonitoring(3000);
    } catch (error) {
        console.error('Application error:', error);
    }
}

monitor.on(
    "blocksUpdated",
    async (validatorAddress, validatorVoteAddress, subscription) => {
        try {
            const currentEpochInfo = await monitor.getEpochInfo("confirmed");
            const currentEpoch = currentEpochInfo?.epoch;
            if (!currentEpoch) {
                console.warn("Could not fetch current epoch, skipping update");
                return;
            }

            const [currentSOLPrice, currentTips, voteAccounts] = await Promise.all([
                monitor.fetchSOLPrice(),
                monitor.getCurrentEpochTips(validatorAddress, currentEpoch),
                monitor.getVoteAccounts(),
            ]);

            const guild = client.guilds.cache.get(subscription.serverId);
            if (!guild) {
                console.warn(`Guild ${subscription.serverId} not found`);
                return;
            }

            
            const validatorData = await monitor.getValidatorData(validatorVoteAddress, currentEpoch);
            if (!validatorData) {
                console.warn(`Could not fetch validator data for ${validatorVoteAddress}`);
                return;
            }

            const { valiData: valiDataObj, jpoolData, jpoolScores, valiStats, pendingStake } = validatorData;

            const valiStatus = voteAccounts.current.find(
                (acc) => acc.votePubkey === validatorVoteAddress
            );

            const apy = (jpoolData.apy || 0) * 100 + (jpoolData.jito_apy || 0) * 100;

            const container = new ContainerBuilder();

            const text = new TextDisplayBuilder().setContent(
                `### [${valiStats.name || validatorAddress}](https://solscan.io/account/${validatorAddress}) **┃** ${valiStatus ? "\`🟩 Voting\`" : "\`🟥 Delinquent\`"
                }`
            );
            container.addTextDisplayComponents(text);

            const emoji = pendingStake.total_activation > 0 ? "<:up:1401299682138783866>" : pendingStake.total_activation < 0 ? "<:down:1401299702661644378>" : "";

            const text2 = new TextDisplayBuilder().setContent(`
**Current Epoch:** ${currentEpoch}
**Active Stake:** <:sol:1397286031593705512> ${Number(((jpoolScores.activeStake || 0) / 1e9)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ($${Number(((jpoolScores.activeStake || 0) / 1e9) * currentSOLPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})
**Pending Stake:** ${emoji} ${Number(((pendingStake.total_activation || 0) / 1e9)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ($${Number(((pendingStake.total_activation || 0) / 1e9) * currentSOLPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})
**APY:** ${apy.toFixed(2)}% (${((jpoolData.apy || 0) * 100).toFixed(2)}% + ${((jpoolData.jito_apy || 0) * 100).toFixed(2)}%)
**Commission + Jito:** ${valiDataObj.fee || 0}% + ${(jpoolData.jito_commission_bps || 0) / 100}%
**Client:** ${valiStats.nodeVersion?.startsWith("0") ? "<:firedancer:1412723442855186532> FD v" : "<:agave:1412887410554966186> Agave v"}${valiStats.nodeVersion || "N/A"}`);

            const section2 = new SectionBuilder()
                .addTextDisplayComponents(text2)
                .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL(
                        valiStats.iconUrl ||
                        "https://media.discordapp.net/attachments/1366369127953989692/1412738451303829565/image.jpg"
                    )
                );

            container.addSectionComponents(section2);

            const leaderSlotsRemaining =
                (valiStats.leaderSlotsTotal || 0) - (valiStats.leaderSlotsDone || 0);

            const text3 = new TextDisplayBuilder()
                .setContent(
                    `${leaderSlotsRemaining > 0
                        ? `**Leader Slots (Skipped/Done/Total):** ${leaderSlotsRemaining}/${valiStats.leaderSlotsDone || 0}/${valiStats.leaderSlotsEpoch || 0
                        }`
                        : `**Leader Slots (Done/Total):** ${valiStats.leaderSlotsDone || 0
                        }/${valiStats.leaderSlotsEpoch || 0}`
                    }
**TVC Rank/Credits:** #${valiStats.tvcRank || 0}/${valiStats.tvCredits || 0}
**JPool Rank/Score:** #${jpoolScores.jpoolRank || 0}/${jpoolScores.jpoolScore || 0}
**Fees Earned:** <:sol:1397286031593705512> ${(Number(valiDataObj.votingReward || 0) / 1e9).toFixed(2)} ($${((Number(valiDataObj.votingReward || 0) / 1e9) * currentSOLPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})
${jpoolData.jito_commission_bps > 0
                        ? `**Tips Earned:** <:sol:1397286031593705512> ${(currentTips.totalTipsSOL * jpoolData.jito_commission_bps / 10000).toFixed(2)} ($${(
                            (currentTips.totalTipsSOL * (jpoolData.jito_commission_bps / 10000)) * currentSOLPrice
                        ).toFixed(2)})`
                        : ""
                    }
-# Last Updated: <t:${Math.floor(Date.now() / 1000)}:R>`
                );
            container.addTextDisplayComponents(text3);

            try {
                const channel = guild.channels.cache.get(subscription.updatingStatus.channelId);
                
                if (!channel) {
                    console.log(`⚠️ Channel ${subscription.updatingStatus.channelId} not found, removing subscription`);
                    
                    // Find the parent subscription document and remove this subscription
                    const parentDoc = await validatorSubscriptionSchema.findOne({
                        "subscriptions._id": subscription._id
                    });
                    
                    if (parentDoc) {
                        
                        const result = await validatorSubscriptionSchema.findOneAndUpdate(
                            { _id: parentDoc._id },
                            { $pull: { subscriptions: { _id: subscription._id } } },
                            { new: true }
                        );
                        
                        if (result && (!result.subscriptions || result.subscriptions.length === 0)) {
                            await validatorSubscriptionSchema.deleteOne({ _id: parentDoc._id });
                            console.log(`🗑️ Deleted validator subscription ${parentDoc._id} - no channels remaining`);
                        } else {
                            console.log(`🧹 Removed invalid channel subscription from ${parentDoc._id}`);
                        }
                    }
                    return;
                }
                
                const message = await channel.messages.fetch(subscription.updatingStatus.messageId);

                await message.edit({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2,
                });
            } catch (error) {
                console.log(`❌ Failed to update message for ${validatorAddress}:`, error.message);
                
                
                if (error.code === 10008 || error.code === 50001 || error.code === 50013) { 
                    const parentDoc = await validatorSubscriptionSchema.findOne({
                        "subscriptions._id": subscription._id
                    });
                    
                    if (parentDoc) {
                        const result = await validatorSubscriptionSchema.findOneAndUpdate(
                            { _id: parentDoc._id },
                            { $pull: { subscriptions: { _id: subscription._id } } },
                            { new: true }
                        );
                        
                        
                        if (result && (!result.subscriptions || result.subscriptions.length === 0)) {
                            await validatorSubscriptionSchema.deleteOne({ _id: parentDoc._id });
                            console.log(`🗑️ Deleted validator subscription ${parentDoc._id} - no channels remaining`);
                        } else {
                            console.log(`🧹 Removed invalid updating status subscription from ${parentDoc._id}`);
                        }
                    }
                } else {
                    
                    await validatorSubscriptionSchema.updateOne(
                        { "subscriptions._id": subscription._id },
                        { $set: { "subscriptions.$.updatingStatus.status": false } }
                    );
                    console.log(`Disabled updating status for ${validatorAddress} due to error`);
                }
                return;
            }
        } catch (err) {
            console.error("Error updating validator message:", err);
        }
    }
);

export { main, SolanaContinuousValidatorMonitor };