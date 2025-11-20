import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { getMainnetList } from "../validatorList.js";
import validatorSubscriptionSchema from "../schema/validatorSubscriptions.js";

export default {
  name: "stats-message",
  description: "Create a live-updating validator stats message in a channel",
  options: [
    { name: "channel", description: "The Channel To Send The Message To", type: 7, channelTypes: [0, 5], required: true },
    { name: "validator", description: "The Validator To Track", type: 3, required: true, autocomplete: true },
  ],

  run: async (client, interaction) => {
    if (!interaction.member.permissions.has("ManageGuild"))
      return interaction.reply({ content: `<:cross:1399399676696068127> **You do not have permission to use this command.**`, ephemeral: true });

    const channel = interaction.options.getChannel("channel");
    const validatorInput = interaction.options.getString("validator");
    const validatorList = getMainnetList();

    const info = validatorList.find(v => v.voteId === validatorInput);
    if (!info)
      return interaction.reply({ content: `**Invalid validator vote address provided.**`, ephemeral: true });

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### <:tick:1399117596749598801> Now Tracking [${info.name}](https://solscan.io/account/${validatorInput})`)
    );
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `\`🪪\` **Vote ID:** ${info.voteId}\n` +
            `\`🔗\` **Validator ID:** ${info.validatorId}\n\n` +
            `**Message Will Be Updated With Current Epoch Stats Soon!**`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(info.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png")
        )
    );

    const sendMessage = async () => {
      try {
        return await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
      } catch {
        throw new Error(`Failed to send message in ${channel.toString()}. Check bot permissions.`);
      }
    };

    const successMessage = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### <:tick:1399117596749598801> Successfully Subscribed to [${info.name}](https://solscan.io/account/${validatorInput})\n\n-# To unsubscribe simply delete the message sent in the channel.`)
    );

    let valiData = await validatorSubscriptionSchema.findOne({ validatorAddress: info.validatorId });

    try {
      let sentMessage;
      if (valiData) {
        const sub = valiData.subscriptions.find(sub => sub.serverId === interaction.guild.id);
        if (sub?.updatingStatus?.status)
          return interaction.reply({ content: `**This validator is already subscribed in this server.**`, ephemeral: true });
        sentMessage = await sendMessage();
        if (sub) {
          sub.updatingStatus = { status: true, channelId: channel.id, messageId: sentMessage.id };
        } else {
          valiData.subscriptions.push({
            serverId: interaction.guild.id,
            channelId: interaction.channel.id,
            addedAt: new Date(),
            createdBy: interaction.user.id,
            normalStatus: false,
            updatingStatus: { status: true, channelId: channel.id, messageId: sentMessage.id }
          });
        }
        await valiData.save();
      } else {
        sentMessage = await sendMessage();
        await new validatorSubscriptionSchema({
          validatorAddress: info.validatorId,
          validatorVoteAddress: info.voteId,
          subscriptions: [{
            serverId: interaction.guild.id,
            channelId: interaction.channel.id,
            addedAt: new Date(),
            createdBy: interaction.user.id,
            normalStatus: false,
            updatingStatus: { status: true, channelId: channel.id, messageId: sentMessage.id }
          }]
        }).save();
      }
      return interaction.reply({ components: [successMessage], flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      return interaction.reply({ content: `**Failed to subscribe to validator updates. Do I have permission to send messages in the specified channel?**`, ephemeral: true });
    }
  },
};
