/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IConfig {
	// The client ID of the GitHub OAuth app
	gitHubClientId: string;
	gitHubClientSecret?: string;
}

// SHOORA TETHER GitHub OAuth App Credentials
export const Config: IConfig = {
	gitHubClientId: 'Ov23lioBTmWMr4qQv7qU',
	gitHubClientSecret: '6f3f030c3a31f3b5a6a1d8009136c07d876338a0'
};
