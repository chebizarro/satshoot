import { 
    type NDKSigner, 
    type NDKEvent,
    NDKKind,
    NDKRelayList,
    NDKRelay,
    NDKSubscriptionCacheUsage,
} from '@nostr-dev-kit/ndk';

import ndk from '$lib/stores/ndk';

import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';

import currentUser from '../stores/user';
import {
    loggedIn,
    loggingIn,
    loginMethod,
    retryUserInit,
    followsUpdated,
    userRelaysUpdated,
} from '../stores/user';

import {
    updateFollowsAndWotScore,
    networkWoTScores,
} from '../stores/wot';

import {
    allReviews,
} from '$lib/stores/reviews';

import {
    allReceivedZapsFilter,
    allReceivedZaps,
} from '$lib/stores/zaps';

import { 
    messageStore,
    sentMessageFilter,
    receivedMessageFilter,
} from '$lib/stores/messages';

import { 
    allTickets,
    allOffers,
    myTicketFilter,
    myOfferFilter,
    myTickets,
    myOffers,
} from "$lib/stores/troubleshoot-eventstores";

import { DEFAULTRELAYURLS } from '$lib/stores/ndk';
import { notifications } from '../stores/notifications';

import { goto } from '$app/navigation';
import { get } from "svelte/store";
import { dev, browser } from '$app/environment';
import { connected, sessionPK } from '../stores/ndk';
import {
    retryConnection,
    retriesFailed,
    retryDelay
} from '../stores/network';


export async function initializeUser(ndk: NDK) {
    console.log('begin user init')
    try {
        loggingIn.set(false);

        const user = await (ndk.signer as NDKSigner).user();
        if (user.npub) {
            loggedIn.set(true);
        } else return;

        currentUser.set(user);

        myTicketFilter.authors! = [user.pubkey];
        myOfferFilter.authors! = [user.pubkey];

        myTickets.startSubscription();
        myOffers.startSubscription();
        
        // --------- User Profile --------------- //
        const profile = await user.fetchProfile(
            {cacheUsage: NDKSubscriptionCacheUsage.PARALLEL}
        );
        // for now loading profile from cache disabled but if reenabled, this bug
        // that profile returned is a strangely nested object should be handled
        if (profile) {
            user.profile = profile;
        }
        currentUser.set(user);

        // fetch users relays. If there are no outbox relays, set default ones
        const relays = await fetchUserOutboxRelays(ndk);
        if (!relays) {
            broadcastRelayList(ndk, DEFAULTRELAYURLS, DEFAULTRELAYURLS);
            userRelaysUpdated.set(true);
        }

        const $followsUpdated = get(followsUpdated) as number;
        // Update wot every 5 hours: Newbies can get followers and after 5 hours
        // their actions will be visible to a decent amount of people
        const updateDelay = Math.floor(Date.now() / 1000) - 60 * 60 * 5;

        // let wotArray: string[] = Array.from(get(wot));
        const $networkWoTScores = get(networkWoTScores);

        if ( ($followsUpdated < updateDelay)
            || !($networkWoTScores)
            || $networkWoTScores.size === 0
        ) {
            // console.log('wot outdated, updating...')
            await updateFollowsAndWotScore(ndk);
            // console.log('wot updated')
            // wotArray = Array.from(get(wot));
        } 

        // Start all tickets/offers sub
        allTickets.startSubscription();
        allOffers.startSubscription();

        receivedMessageFilter['#p']! = [user.pubkey];
        sentMessageFilter['authors'] = [user.pubkey];
        allReceivedZapsFilter['#p']! = [user.pubkey];
        
        // Start message and review subs after successful wot and follow recalc
        messageStore.startSubscription();
        allReviews.startSubscription();
        allReceivedZaps.startSubscription();

        retryUserInit.set(false);
    } catch(e) {
        console.log('Could not initialize User. Reason: ', e)
        if (browser && !get(retryUserInit)) {
            retryUserInit.set(true);
            console.log('Retrying...');
            window.location.reload();
        }
    }
}

export async function logout() {
    console.log('logout')

    loggedIn.set(false);

    loginMethod.set(null);

    followsUpdated.set(0);
    networkWoTScores.set(null);

    currentUser.set(null);

    localStorage.clear();
    sessionStorage.clear();

    sessionPK.set('');

    myTickets.empty();
    myOffers.empty();
    myTicketFilter.authors = [];
    myOfferFilter.authors = [];

    allTickets.empty();
    allOffers.empty();

    messageStore.empty();
    allReviews.empty();
    allReceivedZaps.empty();

    notifications.set([]);

    get(ndk).signer = undefined;

    goto('/');
}

export async function getActiveServiceWorker(): Promise<ServiceWorker | null> {
    if ('serviceWorker' in navigator) {
        let registeredSW = await 
                (navigator.serviceWorker as ServiceWorkerContainer).getRegistration();
        if (!registeredSW) {
            console.log('No registered Service Worker for this page!');
            console.log('Trying to register one...');
            // Try to register new service worker here
            registeredSW = await 
                (navigator.serviceWorker as ServiceWorkerContainer).register(
                '/service-worker.js',
                {	type: dev ? 'module' : 'classic'}
            );

            if(!registeredSW) return null;
        }

        const activeSW = registeredSW.active;
        if(activeSW) {
            return activeSW;
        } else {
            console.log('No active Service Worker. Must wait for it...')
            console.log(
                (navigator.serviceWorker as ServiceWorkerContainer).getRegistrations()
            );

            let pendingSW;
            if(registeredSW.installing) {
                pendingSW = registeredSW.installing;
            } else if(registeredSW.waiting) {
                pendingSW = registeredSW.waiting;
            }

            if(pendingSW) {
                pendingSW.onstatechange = (event: Event) => {
                    if(registeredSW!.active) {
                        console.log('Regsitered Service worker activated!')
                    }
                };
            }
        }
    } else {
        console.log('service worker not supported')
        return null;
    }

    return null;
}


export async function fetchUserOutboxRelays(ndk: NDKSvelte):Promise<NDKEvent | null> {
    const $currentUser = get(currentUser);

    // const queryRelays = NDKRelaySet.fromRelayUrls([
    //     ...ndk.pool.urls(),
    //     ...ndk.outboxPool!.urls()
    // ], ndk);

    const relays = await ndk.fetchEvent(
        { kinds: [10002], authors: [$currentUser!.pubkey] },
        { 
            cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
            groupable: false,
        },
        // queryRelays,
    );
    console.log('outbox relays', relays)
    return relays;
}

export async function broadcastRelayList(ndk: NDKSvelte, readRelayUrls: string[], writeRelayUrls: string[]) {
    const userRelayList = new NDKRelayList(ndk);
    userRelayList.readRelayUrls = Array.from(readRelayUrls);
    userRelayList.writeRelayUrls = Array.from(writeRelayUrls);

    const blastrUrl = 'wss://nostr.mutinywallet.com';
    ndk.pool.useTemporaryRelay(new NDKRelay(blastrUrl, undefined, ndk));
    // const broadCastRelaySet = NDKRelaySet.fromRelayUrls([
    //     blastrUrl,
    //     ...ndk.pool.urls(),
    //     ...ndk.outboxPool!.urls()
    // ], ndk);
    console.log('relays sending to:', ndk.pool.urls());

    const relaysPosted = await userRelayList.publish();
    console.log('relays posted to:', relaysPosted)
}

export function troubleshootZap(zap: NDKEvent): boolean {
    const zapKind = (zap.kind === NDKKind.Zap);
    if (!zapKind) {
        return false;
    }

    const aTag = zap.tagValue('a');

    if (!aTag) return false;

    const kindFromATag = aTag.split(':')[0];

    if (!kindFromATag) return false;

    if (kindFromATag) {
        const offerEventZapped = (
            parseInt(kindFromATag) === NDKKind.TroubleshootOffer
        );

        if (!offerEventZapped) return false;
    }

    return true;
}

export function restoreRelaysIfDown() {
    const $ndk = get(ndk);
    console.log('Check relays and try to reconnect if they are down..')
    if ($ndk.pool.stats().connected === 0) {
        connected.set(false);
        const retriesLeft = get(retryConnection);
        console.log('retryConnection', retriesLeft)
        if (retriesLeft > 0) {
            retryConnection.set(retriesLeft - 1);
            // Try to reconnect to relays
            $ndk.pool.connect();
            // Re-check recursively
            setTimeout(restoreRelaysIfDown, retryDelay);
            // window.location.reload();
        } else { 
            // This is to always trigger this not just once.
            // When user navigates this check can run multiple times
            // but if a boolean was used, this could only be triggered once
            retriesFailed.set(get(retriesFailed) + 1);
        }

    }
}
