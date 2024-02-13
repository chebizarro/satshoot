import { BTCTroubleshootKind } from "./kinds";
import { NDKEvent, type NDKTag, type NostrEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { NDKRelaySet } from "@nostr-dev-kit/ndk";
import { OfferEvent } from "./OfferEvent";

export enum TicketStatus {
    New = 0,
    InProgress = 1,
    Closed = 2,
}


export class TicketEvent extends NDKEvent {
    private _status: TicketStatus;
    private _title: string;
    private _tTags: NDKTag[];
    private _offersOnTicket: Set<OfferEvent> | null;

    constructor(ndk?: NDK, rawEvent?: NostrEvent) {
        super(ndk, rawEvent);
        this.kind ??= BTCTroubleshootKind.Ticket;
        this._status = parseInt(this.tagValue('status') as string);
        this._title = this.tagValue('title') as string;
        this._tTags = this.tags.filter((tag:NDKTag) => tag[0]==='t');
        this._offersOnTicket = null;
    }

    static from(event:NDKEvent){
        return new TicketEvent(event.ndk, event.rawEvent());
    }

    get ticketAddress(): string {
        return this.tagAddress();
    }

    // this.generateTags() will take care of setting d-tag

    get acceptedOfferAddress(): string | undefined {
        return this.tagValue("a");
    }

    set acceptedOfferAddress(offerAddress: string) {
        // Can only have exactly one accepted offer tag
        this.removeTag('a');
        this.tags.push(['a', offerAddress]);
    }

    get title(): string {
        return this._title;
    }

    set title(title: string) {
        this._title = title;
        // Can only have exactly one title tag
        this.removeTag('title');
        this.tags.push(['title', title]);
    }

    get status(): TicketStatus {
        return this._status;
    }

    set status(status: TicketStatus) {
        this._status = status;
        this.removeTag('status');
        this.tags.push(['status', status.toString()]);
    }
    
    get description(): string {
        return this.content;
    }

    set description(desc: string) {
        this.content = desc;
    }

    get tTags(): NDKTag[] {
        return this._tTags;
    }

    set tTags(tags: NDKTag[]) {
        this._tTags = tags;
    }

    get offersOnTicket(): Set<OfferEvent> {
        return this._offersOnTicket;
    }

    public startOfferSubs() {

        if (this.ndk) {
            const sub = this.ndk.subscribe(
                {
                    kinds: [BTCTroubleshootKind.Offer as number],
                    '#a': [this.ticketAddress],
                },
                {},
                new NDKRelaySet(new Set(this.ndk.pool.relays.values()), this.ndk)
            );
            
            sub.on("event", (e: NDKEvent) => {
                if (!this._offersOnTicket) {
                    this._offersOnTicket = new Set();
                }
                this._offersOnTicket.add(OfferEvent.from(e));
                console.log('offer arrived, adding to offersOnTicket')
            });

            sub.start();
        }
    }


}
