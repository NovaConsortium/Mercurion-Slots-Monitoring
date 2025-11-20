import { MessageFlags, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, ContainerBuilder } from "discord.js";
import validatorDMSubscriptionSchema from "../schema/validatorDMSubscriptions.js";
import { getMainnetList } from "../validatorList.js";

export default {
  name: "stats-dm-remove",
  description: "Stop validator stats in DM",
  options: [
    {
      name: 'name',
      description: 'The Validator Name OR Vote Address',
      type: 3,
      required: true,
      autocomplete: true
    }
  ],
  run: async (client, interaction, args) => {
        if (!interaction.member.permissions.has("ManageGuild")) return interaction.reply({ content: `<:cross:1399399676696068127> **You do not have permission to use this command.**`, ephemeral: true });
    const validatorVoteAddress = interaction.options.getString('name');
    const validatorList = getMainnetList();

    const info = validatorList.find(v => v.voteId === validatorVoteAddress);
    if (!info) {
      return interaction.reply({ content: `**Invalid validator vote address provided.**`, ephemeral: true });
    }

    const existingSubscription = await validatorDMSubscriptionSchema.findOne({ validatorAddress: info.validatorId });
    if (!existingSubscription) {
      return interaction.reply({ content: `**No subscription found for this validator.**`, ephemeral: true });
    }

    const subscriberIndex = existingSubscription.subscribers.findIndex(sub => sub.userId === interaction.user.id);
    if (subscriberIndex === -1) {
      return interaction.reply({ content: `**You are not subscribed to this validator.**`, ephemeral: true });
    }

    existingSubscription.subscribers.splice(subscriberIndex, 1);
    
    if (existingSubscription.subscribers.length === 0) {
      await validatorDMSubscriptionSchema.deleteOne({ validatorAddress: info.validatorId });
    } else {
      await existingSubscription.save();
    }

    const container = new ContainerBuilder();
    const text = new TextDisplayBuilder()
      .setContent(`### <:cross:1399399676696068127> Removed [${info.name}](https://solscan.io/account/${info.validatorId}) from DM subscriptions.`);

    container.addTextDisplayComponents(text);

    const text2 = new TextDisplayBuilder()
      .setContent(`\`🪪\` **Vote ID:** ${validatorVoteAddress}\n\`🔗\` **Validator ID:** ${info.validatorId}\n\`⚙️\` **Version:** ${info.nodeVersion}`);

    const section2 = new SectionBuilder()
      .addTextDisplayComponents(text2)
      .setThumbnailAccessory(
        new ThumbnailBuilder()
          .setURL(info.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
      );

    container.addSectionComponents(section2);

    return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }
}