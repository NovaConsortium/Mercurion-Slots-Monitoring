import { ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, AttachmentBuilder } from "discord.js";
import validatorSubscriptionSchema from "../schema/validatorSubscriptions.js";
import { getMainnetList } from "../validatorList.js";
import StaticMaps from 'staticmaps';

export default {
    name: "validator-info",
    description: "Get information about a validator",
    options: [
        {
            name: 'validator',
            description: 'The Validator Name OR Vote Address',
            type: 3,
            required: true,
            autocomplete: true
        }
    ],
    run: async (client, interaction, args) => {
        const validatorAddress = interaction.options.getString('validator');
        const validatorList = getMainnetList();

        let info = validatorList.find(v => v.voteId === validatorAddress);
        if (!info) {
            return interaction.reply({ content: `**Invalid validator vote address provided.**`, ephemeral: true });
        }

        let validatorData = await fetch(`https://www.validators.app/api/v1/validators/mainnet/novaeuhY2JH2WHhc9KVTHDx2cyJZdXJC6faf4CtARZn.json?with_history=true`, {
            headers: {
                'Token': process.env.validatorsAppApi
            }
        })
        validatorData = await validatorData.json();

        const stakePoolsEmoji = {
            "Marinade": "<:marinade:1422323590942031933>",
            "Jpool": "<:jpool:1422321534218928158>",
            "DAOPool": "<:daopool:1422323970895511652>",
            "BlazeStake": "<:blazestake:1422321126574522548>",
            "Jito": "<:jitopool:1422323640648728657>",
            "Edgevana": "<:edgevana:1422323618301476988>",
            "Aero": "<:aero:1422321511112380488>",
            "Shinobi": "<:shinobi:1422321294501875752>",
            "Vault": "<:thevault:1420867315141968063>",
            "DynoSol": "<:dynosol:1422321149403988029>",
            "JagPool": "<:jagpool:1422321136506765362>",
            "Definity": "<:definsol:1422323554397192263>"
        }

        const container = new ContainerBuilder();

        
        const mainInfo = new SectionBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder()
                    .setContent(`## ${validatorData.name} ${validatorData.jito ? "<:jito:1422326633762787540>" : ""} ${validatorData.is_dz ? "<:doublezero:1422326611230851093>" : ""} 
-# ${validatorData.details}

**Vote Key:** \`${validatorData.vote_account}\`
**Pub Key:** \`${validatorData.account}\`
**Status:** ${validatorData.is_active ? '🟢 Active' : '🔴 Inactive'} ${validatorData.delinquent ? '⚠️ Delinquent' : ''}
**Software:** ${validatorData.software_client === "Firedancer" ? "<:firedancer:1412869272618799245>" : "<:agave:1412887410554966186>"} v${validatorData.software_version}
**Stake Pools:** ${validatorData.stake_pools_list.map(pool => stakePoolsEmoji[pool]).join(' ')}`)
            )
            .setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(validatorData.avatar_url || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
            );
        container.addSectionComponents(mainInfo);

        
        const performanceInfo = new TextDisplayBuilder()
            .setContent(`### 📊 Performance Metrics
**Total Score:** ${validatorData.total_score}/13
**Commission:** ${validatorData.commission}%
**Active Stake:** ${(validatorData.active_stake / 1e9).toLocaleString()} <:SOL:1422327225956434063>
**Epoch Credits:** ${validatorData.epoch_credits.toLocaleString()}
**Skipped Slots:** ${validatorData.skipped_slots} (${validatorData.skipped_slot_percent}%)
**Epoch:** ${validatorData.epoch}`);

        
        const locationInfo = new TextDisplayBuilder()
            .setContent(`### 🌍 Infrastructure
**Data Center:** ${validatorData.data_center_key}
**Location:** ${validatorData.latitude}, ${validatorData.longitude}
**IP:** \`${validatorData.ip}\`
**ASN:** ${validatorData.autonomous_system_number}`);

        
        const linksInfo = new TextDisplayBuilder()
            .setContent(`### 🔗 Links
**Website:** ${validatorData.www_url || 'Not provided'}
**Solscan:** [View on Solscan](https://solscan.io/account/${validatorAddress})`);


        
        container.addTextDisplayComponents(performanceInfo, locationInfo, linksInfo);

        await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });
    }
}