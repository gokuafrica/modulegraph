import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

@Injectable()
export class KmsService {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new KMSClient({ region: this.configService.get('kms.region') });
    this.keyId = this.configService.get('kms.keyId');
  }

  async encryptString(plaintext: string): Promise<string> {
    const result = await this.client.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(plaintext, 'utf8') }));
    return Buffer.from(result.CiphertextBlob).toString('base64');
  }

  async decryptString(ciphertext: string): Promise<string> {
    const result = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(ciphertext, 'base64') }));
    return Buffer.from(result.Plaintext).toString('utf8');
  }
}
