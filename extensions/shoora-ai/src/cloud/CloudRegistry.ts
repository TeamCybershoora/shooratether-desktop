/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cybershoora Pvt. Ltd. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ICloudProvider } from './types.js';
import { AWSProvider } from './providers/AWSProvider.js';

export class CloudRegistry {
    private static instance: CloudRegistry;
    private providers: Map<string, ICloudProvider> = new Map();
    private activeProviderId: string = 'aws';

    private constructor() {
        // Register default providers
        this.registerProvider(new AWSProvider());
    }

    public static getInstance(): CloudRegistry {
        if (!CloudRegistry.instance) {
            CloudRegistry.instance = new CloudRegistry();
        }
        return CloudRegistry.instance;
    }

    public registerProvider(provider: ICloudProvider): void {
        this.providers.set(provider.id, provider);
    }

    public getProvider(id: string): ICloudProvider | undefined {
        return this.providers.get(id);
    }

    public getActiveProvider(): ICloudProvider {
        const provider = this.providers.get(this.activeProviderId);
        if (!provider) {
            const first = Array.from(this.providers.values())[0];
            if (!first) {
                throw new Error('No cloud providers registered.');
            }
            return first;
        }
        return provider;
    }

    public setActiveProvider(id: string): void {
        if (!this.providers.has(id)) {
            throw new Error(`Provider '${id}' is not registered.`);
        }
        this.activeProviderId = id;
    }

    public listProviders(): Array<{ id: string; name: string; icon: string }> {
        return Array.from(this.providers.values()).map((p) => ({
            id: p.id,
            name: p.name,
            icon: p.icon
        }));
    }
}
