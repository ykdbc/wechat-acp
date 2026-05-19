import crypto from "node:crypto";

import { getUploadUrl, sendMessage } from "./api.js";
import { encryptedSize, uploadToCdn } from "./media.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  UploadMediaType,
} from "./types.js";
import type { WeixinSendOpts } from "./send.js";

export async function sendImageMessage(
  to: string,
  image: { buffer: Buffer; mimeType: string },
  opts: WeixinSendOpts & { cdnBaseUrl: string },
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const encodedAesKey = Buffer.from(aesKeyHex, "utf-8").toString("base64");
  const filekey = crypto.randomBytes(16).toString("hex");
  const md5 = crypto.createHash("md5").update(image.buffer).digest("hex");
  const ciphertextSize = encryptedSize(image.buffer.length);

  const upload = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: to,
      rawsize: image.buffer.length,
      rawfilemd5: md5,
      filesize: ciphertextSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    },
  });

  if (!upload.upload_param) {
    throw new Error("WeChat upload URL response did not include upload_param");
  }

  const downloadParam = await uploadToCdn({
    buffer: image.buffer,
    uploadParam: upload.upload_param,
    uploadFullUrl: upload.upload_full_url,
    aesKey,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
  });

  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: encodedAesKey,
                encrypt_type: 1,
              },
              aeskey: encodedAesKey,
              mid_size: ciphertextSize,
              hd_size: ciphertextSize,
            },
          },
        ],
      },
    },
  });

  return clientId;
}
