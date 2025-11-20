let mainnetList = [];

export async function loadValidatorLists() {
    try {
        const mainnetValidatorList = await fetch(`https://api.thevalidators.io/validators/list?network=mainnet&select=voteId,validatorId,totalStake,iconUrl,name,nodeVersion,details,network`).then(res => res.json());
        mainnetList = (mainnetValidatorList.data || []).filter(item => item.name !== null);
        console.log(`✅ Loaded ${mainnetList.length} validators from API`);
    } catch (error) {
        console.error(`Failed to load validator list:`, error);
        if (mainnetList.length === 0) {
            console.error('⚠️ No validator list available. Using empty array.');
        }
    }
}

export function getMainnetList() {
    return mainnetList;
}

export function findValidatorInfoByVote(voteId) {
    if (!voteId) return null;
    const validator = mainnetList.find(v => v.voteId === voteId);
    if (validator) return { ...validator, network: 'mainnet' };
    return null;
}

export function findValidatorInfoById(validatorId) {
    if (!validatorId) return null;
    const validator = mainnetList.find(v => v.validatorId === validatorId);
    if (validator) return { ...validator, network: 'mainnet' };
    return null;
}

loadValidatorLists();

