/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Oracle Corporation code.
 *
 * The Initial Developer of the Original Code is
 *  Oracle Corporation
 * Portions created by the Initial Developer are Copyright (C) 2004
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Vladimir Vukicevic <vladimir.vukicevic@oracle.com>
 *   Dan Mosedale <dan.mosedale@oracle.com>
 *   Mike Shaver <mike.x.shaver@oracle.com>
 *   Gary van der Merwe <garyvdm@gmail.com>
 *   Bruno Browning <browning@uwalumni.com>
 *   Matthew Willis <lilmatt@mozilla.com>
 *   Daniel Boelzle <daniel.boelzle@sun.com>
 *   Philipp Kewisch <mozilla@kewis.ch>
 *   Wolfgang Sourdeau <wsourdeau@inverse.ca>
 *   Simon Vaillancourt <simon.at.orcl@gmail.com>
 *
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

Components.utils.import("resource://calendar/modules/calUtils.jsm");
Components.utils.import("resource://calendar/modules/calIteratorUtils.jsm");
Components.utils.import("resource://calendar/modules/calProviderUtils.jsm");
Components.utils.import("resource://calendar/modules/calAuthUtils.jsm");

//
// calDavCalendar.js
//
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';

function calDavCalendar() {
    this.initProviderBase();
    this.unmappedProperties = [];
    this.mUriParams = null;
    this.mItemInfoCache = {};
    this.mCalHomeSet = null;
    this.mInboxUrl = null;
    this.mOutboxUrl = null;
    this.mCalendarUserAddress = null;
    this.mPrincipalUrl = null;
    this.mSenderAddress = null;
    this.mHrefIndex = {};
    this.mAuthScheme = null;
    this.mAuthRealm = null;
    this.mObserver = null;
    this.mFirstRefreshDone = false;
    this.mOfflineStorage = null;
    this.mQueuedQueries = [];
    this.mCtag = null;

    // By default, support both events and todos.
    this.mGenerallySupportedItemTypes = ["VEVENT", "VTODO"];
    this.mSupportedItemTypes = this.mGenerallySupportedItemTypes.slice(0);
    this.readOnly = true;
    this.disabled = true;
    /* ACL code */
    this.mACLEntry = null;
    /* /ACL code */

    let refreshDelay = getPrefSafe("calendar.caldav.refresh.initialdelay", 0);
    if (refreshDelay > 0) {
        let now = (new Date()).getTime();
        this.mFirstRefreshDelay = now + refreshDelay * 1000;
        LOG("[caldav] first refresh should not occur before: "
            + this.mFirstRefreshDelay);
    }
    else {
        this.mFirstRefreshDelay = 0;
    }
}

// some shorthand
const calICalendar = Components.interfaces.calICalendar;
const calIErrors = Components.interfaces.calIErrors;
const calIFreeBusyInterval = Components.interfaces.calIFreeBusyInterval;
const calICalDavCalendar = Components.interfaces.calICalDavCalendar;

// used in checking calendar URI for (Cal)DAV-ness
const kDavResourceTypeNone = 0;
const kDavResourceTypeCollection = 1;
const kDavResourceTypeCalendar = 2;

// used for etag checking
const CALDAV_ADOPT_ITEM = 1;
const CALDAV_MODIFY_ITEM = 2;
const CALDAV_DELETE_ITEM = 3;

calDavCalendar.prototype = {
    __proto__: cal.ProviderBase.prototype,

    //
    // nsISupports interface
    //
    QueryInterface: function caldav_QueryInterface(aIID) {
        return doQueryInterface(this, calDavCalendar.prototype, aIID,
                                [Components.interfaces.calICalendarProvider,
                                 Components.interfaces.nsIInterfaceRequestor,
                                 Components.interfaces.calIFreeBusyProvider,
                                 Components.interfaces.nsIChannelEventSink,
                                 Components.interfaces.calIItipTransport,
                                 Components.interfaces.calIChangeLog,
                                 calICalDavCalendar]);
    },

    // An array of components that are supported by the server. The default is
    // to support VEVENT and VTODO, if queries for these components return a 4xx
    // error, then they will be removed from this array.
    mGenerallySupportedItemTypes: null,
    mSupportedItemTypes: null,
    suportedItemTypes: null,
    get supportedItemTypes() {
        return this.mSupportedItemTypes;
    },

    get isCached() {
        return (this != this.superCalendar);
    },

    ensureTargetCalendar: function caldav_ensureTargetCalendar() {
        if (!this.isCached && !this.mOfflineStorage) {
            // If this is a cached calendar, the actual cache is taken care of
            // by the calCachedCalendar facade. In any other case, we use a
            // memory calendar to cache things.
            this.mOfflineStorage = Components
                                   .classes["@mozilla.org/calendar/calendar;1?type=memory"]
                                   .createInstance(Components.interfaces.calISyncWriteCalendar);

            this.mOfflineStorage.superCalendar = this;
            this.mObserver = new calDavObserver(this);
            this.mOfflineStorage.addObserver(this.mObserver);
            this.mOfflineStorage.setProperty("relaxedMode", true);
        }
    },

    //
    // calICalendarProvider interface
    //
    get prefChromeOverlay() {
        return null;
    },

    get displayName() {
        return calGetString("calendar", "caldavName");
    },

    createCalendar: function caldav_createCalendar() {
        throw NS_ERROR_NOT_IMPLEMENTED;
    },

    deleteCalendar: function caldav_deleteCalendar(cal, listener) {
        throw NS_ERROR_NOT_IMPLEMENTED;
    },

    // calIChangeLog interface
    setOfflineStorage: function caldav_setOfflineStorage(storage) {
        this.mOfflineStorage = storage;
        this.fetchCachedMetaData();
    },

    fetchCachedMetaData: function caldav_fetchCachedMetaData() {
        let cacheIds = {};
        let cacheValues = {};
        this.mOfflineStorage.getAllMetaData({}, cacheIds, cacheValues);
        cacheIds = cacheIds.value;
        cacheValues = cacheValues.value;
        let needsResave = false;
        let calendarProperties = null;
        for (let count = 0; count < cacheIds.length; count++) {
            let itemId = cacheIds[count];
            let itemData = cacheValues[count];
            if (itemId == "ctag") {
                this.mCtag = itemData;
                this.mOfflineStorage.deleteMetaData("ctag");
            } else if (itemId == "sync-token") {
                this.mWebdavSyncToken = itemData;
                this.mOfflineStorage.deleteMetaData("sync-token");
            } else if (itemId == "calendar-properties") {
                this.restoreCalendarProperties(itemData);
                this.mCheckedServerInfo = true;
                this.setProperty("currentStatus", Components.results.NS_OK);
                this.readOnly = false;
                this.disabled = false;
		if (this.mHaveScheduling || this.hasAutoScheduling)
		  getFreeBusyService().addProvider(this);
            } else {
                let itemDataArray = itemData.split("\u001A");
                let etag = itemDataArray[0];
                let resourcePath = itemDataArray[1];
                let isInboxItem = itemDataArray[2];
                if (itemDataArray.length == 3) {
                    this.mHrefIndex[resourcePath] = itemId;
                    let locationPath = decodeURIComponent(resourcePath)
                        .substr(this.mLocationPath.length);
                    let item = { etag: etag,
                                 isNew: false,
                                 locationPath: locationPath,
                                 isInboxItem: (isInboxItem == "true")};
                    this.mItemInfoCache[itemId] = item;
                }
            }
        }
    },

    get offlineCachedProperties() {
        return [ "mAuthScheme", "mAuthRealm", "mHasWebdavSyncSupport",
                 "mCtag", "mWebdavSyncToken", "mSupportedItemTypes",
                 "mPrincipalUrl", "mCalHomeSet",
                 "mShouldPollInbox", "hasAutoScheduling", "mHaveScheduling",
                 "mCalendarUserAddress", "mShouldPollInbox", "mOutboxUrl" ];
    },

    saveCalendarProperties: function caldav_saveCalendarProperties() {
        let properties = {};
        for each (let property in this.offlineCachedProperties) {
            if (this[property] !== undefined) {
                properties[property] = this[property];
            }
        }
        this.mOfflineStorage.setMetaData("calendar-properties", JSON.stringify(properties));
    },

    restoreCalendarProperties: function caldav_restoreCalendarProperties(data) {
        let properties = JSON.parse(data);
        for each (let property in this.offlineCachedProperties) {
            if (properties[property] !== undefined) {
                this[property] = properties[property];
            }
        }
    },

    resetLog: function caldav_resetLog() {
        if (this.isCached && this.mOfflineStorage) {
            this.mOfflineStorage.startBatch();
            try {
                for (let itemId in this.mItemInfoCache) {
                    this.mOfflineStorage.deleteMetaData(itemId);
                    delete this.mItemInfoCache[itemId];
                }
            } finally {
                this.mOfflineStorage.endBatch();
            }
        }
    },

    // in calISyncWriteCalendar aDestination,
    // in calIGenericOperationListener aListener
    replayChangesOn: function caldav_replayChangesOn(aChangeLogListener) {
        if (!this.mCheckedServerInfo) {
            // If we haven't refreshed yet, then we should check the resource
            // type first. This will call refresh() again afterwards.
            this.checkDavResourceType(aChangeLogListener);
        } else {
            this.safeRefresh(aChangeLogListener);
        }
    },
    setMetaData: function caldav_setMetaData(id, path, etag, isInboxItem) {
        if (this.mOfflineStorage.setMetaData) {
            if (id) {
                let dataString = [etag,path,(isInboxItem ? "true" : "false")].join("\u001A");
                this.mOfflineStorage.setMetaData(id, dataString);
            } else {
                cal.LOG("CAlDAV: cannot store meta data without an id");
            }
        } else {
            cal.LOG("CalDAV: calendar storage does not support meta data");
        }
    },

    //
    // calICalendar interface
    //

    // readonly attribute AUTF8String type;
    get type() { return "caldav"; },

    mCalendarUserAddress: null,
    get calendarUserAddress() {
        return this.mCalendarUserAddress;
    },

    mPrincipalUrl: null,
    get principalUrl() {
        return this.mPrincipalUrl;
    },

    get canRefresh() {
        // A cached calendar doesn't need to be refreshed.
        return !this.isCached;
    },

    // mUriParams stores trailing ?parameters from the
    // supplied calendar URI. Needed for (at least) Cosmo
    // tickets
    mUriParams: null,

    get uri() { return this.mUri; },

    set uri(aUri) {
        this.mUri = aUri;

        return aUri;
    },

    get calendarUri() {
        let calUri = this.mUri.clone();
        let parts = calUri.spec.split('?');
        if (parts.length > 1) {
            calUri.spec = parts.shift();
            this.mUriParams = '?' + parts.join('?');
        }
        if (calUri.spec.charAt(calUri.spec.length-1) != '/') {
            calUri.spec += "/";
        }
        return calUri;
    },

    setCalHomeSet: function caldav_setCalHomeSet() {
        let calUri = this.mUri.clone();
        let split1 = calUri.spec.split('?');
        let baseUrl = split1[0];
        if (baseUrl.charAt(baseUrl.length-1) == '/') {
            baseUrl = baseUrl.substring(0, baseUrl.length-2);
        }
        let split2 = baseUrl.split('/');
        split2.pop();
        calUri.spec = split2.join('/') + '/';
        this.mCalHomeSet = calUri;
    },

    mOutboxUrl:  null,
    get outboxUrl() {
        return this.mOutboxUrl;
    },

    mInboxUrl: null,
    get inboxUrl() {
        return this.mInboxUrl;
    },

    mHaveScheduling: false,
    mShouldPollInbox: true,
    get hasScheduling() { // Whether to use inbox/outbox scheduling
        return this.mHaveScheduling;
    },
    set hasScheduling(value) {
        return (this.mHaveScheduling = (getPrefSafe("calendar.caldav.sched.enabled", false) && value));
    },
    hasAutoScheduling: false, // Whether server automatically takes care of scheduling

    mAuthScheme: null,

    mAuthRealm: null,

    mFirstRefreshDone: false,

    mQueuedQueries: null,

    mCtag: null,

    mOfflineStorage: null,

    // Contains the last valid synctoken returned
    // from the server with Webdav Sync enabled servers
    mWebdavSyncToken: null,
    // Indicates that the server supports Webdav Sync
    // see: http://tools.ietf.org/html/draft-daboo-webdav-sync
    mHasWebdavSyncSupport: false,
    // By default, assume that the server can return the calendar-data
    // property on a sync request, if not supported (ie: Apple Server),
    // a subsequent multiget needs to be sent to the server to retrieve
    // the calendar-data property.
    mHasWebdavSyncCalendarDataSupport: true,

    get authRealm() {
        return this.mAuthRealm;
    },

    makeUri: function caldav_makeUri(aInsertString, aBaseUri) {
        let baseUri = aBaseUri || this.calendarUri;
        let spec = baseUri.spec + (aInsertString || "");
        if (this.mUriParams) {
            spec += this.mUriParams;
        }
        return makeURL(spec);
    },

    get mLocationPath() {
        return decodeURIComponent(this.calendarUri.path);
    },

    getItemLocationPath: function caldav_getItemLocationPath(aItem) {
        if (aItem.id &&
            aItem.id in this.mItemInfoCache &&
            this.mItemInfoCache[aItem.id].locationPath) {
            // modifying items use the cached location path
            return this.mItemInfoCache[aItem.id].locationPath;
        } else {
            // New items just use id.ics
            return aItem.id + ".ics";
        }
    },

    getProperty: function caldav_getProperty(aName) {
        if (this.mACLEntry && this.mACLEntry.hasAccessControl) {
            // Inverse inc. ACL addition
            var ownerIdentities = {};
            switch (aName) {
            case "organizerId":
                this.mACLEntry.getOwnerIdentities({}, ownerIdentities);
                ownerIdentities = ownerIdentities.value;
                if (ownerIdentities.length > 0) {
                    return "mailto:" + ownerIdentities[0].email;
                } else if (this.calendarUserAddress) {
                    return this.calendarUserAddress;
                }
                break;

            case "organizerCN":
                this.mACLEntry.getOwnerIdentities({}, ownerIdentities);
                ownerIdentities = ownerIdentities.value;
                if (ownerIdentities.length > 0) {
                    return ownerIdentities[0].fullName;
                }
                break;

            case "imip.identity":
                this.mACLEntry.getOwnerIdentities({}, ownerIdentities);
                ownerIdentities = ownerIdentities.value;
                if (ownerIdentities.length > 0) {
                    return ownerIdentities[0];
                }
                break;
	    case "capabilities.alarms.actionValues":
	        return ["DISPLAY", "EMAIL"];
            }
        } else {
            switch (aName) {
            case "organizerId":
                if (this.calendarUserAddress) {
                    return this.calendarUserAddress;
                }
                break;

            case "organizerCN":
                break;

            case "imip.identity":
                break;
            }
        }

        switch(aName) {
//         case "cache.updateTimer":
//             return getPrefSafe("calendar.autorefresh.timeout");
 	case "itip.disableRevisionChecks":
	    // important for CalDAV-based calendars since Lightning can
	    // have pulled the latest copy from the server, so the sequence
	    // number (and all other information) will match the invitation
	    // UPDATE, for example
	    return true;
 	case "itip.transport":
            if (this.hasAutoScheduling) {
                return null;
            } else if (this.hasScheduling) {
                return this.QueryInterface(Components.interfaces.calIItipTransport);
            } // else use outbound email-based iTIP (from calProviderBase.js)
            break;
        case "capabilities.tasks.supported":
            return (this.supportedItemTypes.indexOf("VTODO") > -1);
        case "capabilities.events.supported":
            return (this.supportedItemTypes.indexOf("VEVENT") > -1);
        }
        return this.__proto__.__proto__.getProperty.apply(this, arguments);
    },

    promptOverwrite: function caldav_promptOverwrite(aMethod, aItem, aListener, aOldItem) {
        let promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                                      .getService(Components.interfaces.nsIPromptService);

        let promptTitle = calGetString("calendar", "itemModifiedOnServerTitle");
        let promptMessage = calGetString("calendar", "itemModifiedOnServer");
        let buttonLabel1;

        if (aMethod == CALDAV_MODIFY_ITEM) {
            promptMessage += calGetString("calendar", "modifyWillLoseData");
            buttonLabel1 = calGetString("calendar", "proceedModify");
        } else {
            promptMessage += calGetString("calendar", "deleteWillLoseData");
            buttonLabel1 = calGetString("calendar", "proceedDelete");
        }

        let buttonLabel2 = calGetString("calendar", "updateFromServer");

        let flags = promptService.BUTTON_TITLE_IS_STRING *
                    promptService.BUTTON_POS_0 +
                    promptService.BUTTON_TITLE_IS_STRING *
                    promptService.BUTTON_POS_1;

        let choice = promptService.confirmEx(null, promptTitle, promptMessage,
                                             flags, buttonLabel1, buttonLabel2,
                                             null, null, {});

        if (choice == 0) {
            if (aMethod == CALDAV_MODIFY_ITEM) {
                this.doModifyItemOrUseCache(aItem, aOldItem, true, aListener, true);
            } else {
                this.doDeleteItemOrUseCache(aItem, true, aListener, true, false, null);
            }
        } else {
            this.getUpdatedItem(aItem, aListener);
        }

    },

    mItemInfoCache: null,

    mHrefIndex: null,

    /**
     * addItem()
     * we actually use doAdoptItemOrUseCache()
     *
     * @param aItem       item to add
     * @param aListener   listener for method completion
     */
    addItem: function caldav_addItem(aItem, aListener) {
        return this.addItemOrUseCache(aItem, true, aListener);
    },

    addItemOrUseCache: function caldav_addItemOrUseCache(aItem, useCache, aListener){
        let newItem = aItem.clone();
        this.adoptItemOrUseCache(newItem, useCache, aListener);
    },

    /**
     * adoptItem()
     * we actually use doAdoptItemOrUseCache()
     *
     * @param aItem       item to check
     * @param aListener   listener for method completion
     */
    adoptItem: function caldav_adoptItem(aItem, aListener) {
        return this.adoptItemOrUseCache(aItem, true, aListener);
    },

    adoptItemOrUseCache: function caldav_adoptItemOrUseCache(aItem, useCache, aListener){
        return this.doAdoptItemOrUseCache(aItem, useCache, aListener, false);
    },

    /**
     * Performs the actual addition of the item to CalDAV store
     *
     * @param aItem       item to add
     * @param aListener   listener for method completion
     * @param useCache    flag to use the cache when a server failure occurs
     * @param aIgnoreEtag flag to indicate ignoring of Etag
     */
    doAdoptItemOrUseCache: function caldav_doAdoptItemOrUseCache(aItem, useCache, aListener, aIgnoreEtag){
        if (aItem.id == null && aItem.isMutable) {
            aItem.id = getUUID();
        }

        if (aItem.id == null) {
            this.notifyOperationComplete(aListener,
                                         Components.results.NS_ERROR_FAILURE,
                                         Components.interfaces.calIOperationListener.ADD,
                                         aItem.id,
                                         "Can't set ID on non-mutable item to addItem");
            return;
        }

        if (!isItemSupported(aItem, this)) {
            this.notifyOperationComplete(aListener,
                                         Components.results.NS_ERROR_FAILURE,
                                         Components.interfaces.calIOperationListener.ADD,
                                         aItem.id,
                                         "Server does not support item type");
            return;
        }

        let parentItem = aItem.parentItem;
        let locationPath = this.getItemLocationPath(parentItem);
        let itemUri = this.makeUri(locationPath);
        cal.LOG("CalDAV: itemUri.spec = " + itemUri.spec);

        let addListener = {};
        let thisCalendar = this;
        addListener.onStreamComplete =
            function onPutComplete(aLoader, aContext, aStatus, aResultLength,
                                   aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            let status;
            try {
                status = request.responseStatus;
            } catch (ex) {
                status = Components.interfaces.calIErrors.DAV_PUT_ERROR;
            }
            if (thisCalendar.verboseLogging()) {
                let str = cal.convertByteArray(aResult, aResultLength);
                cal.LOG("CalDAV: recv: " + (str || ""));
            }
            // 201 = HTTP "Created"
            // 204 = HTTP "No Content"
            //
            if (status == 201 || status == 204) {
                cal.LOG("CalDAV: Item added to " + thisCalendar.name + " successfully");

                // Some CalDAV servers will modify items on PUT (add X-props,
                // for instance) so we'd best re-fetch in order to know
                // the current state of the item
                // Observers will be notified in getUpdatedItem()
                thisCalendar.getUpdatedItem(parentItem, aListener);
            } else if ((status >= 500 && status <= 510) && useCache) {
                LOG("[calDavCalendar] Server unavailability code recd. Items are being put into cache for a later try");
                thisCalendar.adoptOfflineItem(aItem, aListener);
            } else {
                if (status > 999) {
                    status = "0x" + status.toString(16);
                }
                cal.LOG("CalDAV: Unexpected status adding item to " +
                        thisCalendar.name + ": " + status);

                thisCalendar.reportDavError(Components.interfaces.calIErrors.DAV_PUT_ERROR);
            }
        };

        parentItem.calendar = this.superCalendar;

        let httpchannel = cal.prepHttpChannel(itemUri,
                                              this.getSerializedItem(aItem),
                                              "text/calendar; charset=utf-8",
                                              this);

        if (!aIgnoreEtag) {
            httpchannel.setRequestHeader("If-None-Match", "*", false);
        }

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, addListener);
    },

    adoptOfflineItem: function(item, listener) {
        let this_ = this;
        let opListener = {
            onGetResult: function(calendar, status, itemType, detail, count, items) {
                ASSERT(false, "unexpected!");
            },
            onOperationComplete: function(calendar, status, opType, id, detail) {
                if (Components.isSuccessCode(status)) {
                    let storage = this_.mOfflineStorage.QueryInterface(Components.interfaces.calIOfflineStorage);
                    storage.addOfflineItem(detail, listener);
                } else if (listener) {
                    listener.onOperationComplete(this_, status, opType, id, detail);
                }
            }
        };
        this_.mOfflineStorage.adoptItem(item, opListener);
    },

    /**
     * modifyItem(); required by calICalendar.idl
     * we actually use modifyItemOrUseCache()
     *
     * @param aItem       item to check
     * @param aListener   listener for method completion
    */
    modifyItem: function caldav_modifyItem(aNewItem, aOldItem, aListener) {
        return this.modifyItemOrUseCache(aNewItem, aOldItem, true, aListener);
    },

    modifyItemOrUseCache: function caldav_modifyItemOrUseCache(aNewItem, aOldItem, useCache, aListener){
        let this_ = this;
        let opListener = {
            onGetResult: function(calendar, status, itemType, detail, count, items) {
            },
            onOperationComplete: function(calendar, status, opType, id, detail) {
                let offline_flag = detail;
                if ((offline_flag == "c" || offline_flag == "m") && useCache) {
                    this_.modifyOfflineItem(aNewItem, aOldItem, aListener);
                } else {
                    this_.doModifyItemOrUseCache(aNewItem, aOldItem, useCache, aListener, false);
                }
            }
        };
        let storage = this_.mOfflineStorage.QueryInterface(Components.interfaces.calIOfflineStorage);
        storage.getItemOfflineFlag(aOldItem, opListener);
    },

    /**
     * Modifies existing item in CalDAV store.
     *
     * @param aItem       item to check
     * @param aOldItem    previous version of item to be modified
     * @param useCache    Flag to use the cached entry in case of failure
     * @param aListener   listener from original request
     * @param aIgnoreEtag ignore item etag
     */
    doModifyItemOrUseCache: function caldav_doModifyItemOrUseCache(aNewItem, aOldItem, useCache, aListener, aIgnoreEtag){
        if (aNewItem.id == null) {
            this.notifyOperationComplete(aListener,
                                         Components.results.NS_ERROR_FAILURE,
                                         Components.interfaces.calIOperationListener.MODIFY,
                                         aItem.id,
                                         "ID for modifyItem doesn't exist or is null");
            return;
        }

        let wasInboxItem = this.mItemInfoCache[aNewItem.id].isInboxItem;

        let newItem_ = aNewItem;
        aNewItem = aNewItem.parentItem.clone();
        if (newItem_.parentItem != newItem_) {
            aNewItem.recurrenceInfo.modifyException(newItem_, false);
        }
        aNewItem.generation += 1;

        let eventUri = this.makeUri(this.mItemInfoCache[aNewItem.id].locationPath);

        let thisCalendar = this;

        let modifiedItemICS = this.getSerializedItem(aNewItem);

        let modListener = {};
        modListener.onStreamComplete =
            function caldav_mod_onStreamComplete(aLoader, aContext, aStatus,
                                                 aResultLength, aResult) {
            // 200 = HTTP "OK"
            // 204 = HTTP "No Content"
            //
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            let status;
            try {
                status = request.responseStatus;
            } catch (ex) {
                status = Components.interfaces.calIErrors.DAV_PUT_ERROR;
            }

            // We should not accept a 201 status here indefinitely: it indicates a server error
            // of some kind that we want to know about. It's convenient to accept it for now
            // since a number of server impls don't get this right yet.
            if (status == 204 || status == 201 || status == 200) {
                cal.LOG("CalDAV: Item modified successfully on " + thisCalendar.name);
                // Some CalDAV servers will modify items on PUT (add X-props,
                // for instance) so we'd best re-fetch in order to know
                // the current state of the item
                // Observers will be notified in getUpdatedItem()
                thisCalendar.getUpdatedItem(aNewItem, aListener);
                // SOGo has calendarUri == inboxUri so we need to be careful
                // about deletions
                if (wasInboxItem && thisCalendar.mShouldPollInbox) {
                    thisCalendar.doDeleteItemOrUseCache(aNewItem, true, null, true, true, null);
                }
            } else if (status == 412) {
                thisCalendar.promptOverwrite(CALDAV_MODIFY_ITEM, aNewItem,
                                             aListener, aOldItem);
            } else if ((status >= 500 && status <= 510) && useCache) {
                LOG("[calDavCalendar] doModifyItemOrUseCache received status code of server unavailibity. Putting entry in cache for later try.");
                thisCalendar.modifyOfflineItem(aNewItem, aOldItem, aListener);
            } else {
                if (status > 999) {
                    status = "0x " + status.toString(16);
                }
                cal.LOG("CalDAV: Unexpected status on modifying item on " +
                        thisCalendar.name + ": " + status);
                thisCalendar.reportDavError(Components.interfaces.calIErrors.DAV_PUT_ERROR);
            }
        };

        let httpchannel = cal.prepHttpChannel(eventUri,
                                              modifiedItemICS,
                                              "text/calendar; charset=utf-8",
                                              this);

        if (!aIgnoreEtag) {
            httpchannel.setRequestHeader("If-Match",
                                         this.mItemInfoCache[aNewItem.id].etag,
                                         false);
        }

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, modListener);
    },

    modifyOfflineItem: function(newItem, oldItem, listener) {
        let this_ = this;
        let opListener = {
            onGetResult: function(calendar, status, itemType, detail, count, items) {
                ASSERT(false, "unexpected!");
            },
            onOperationComplete: function(calendar, status, opType, id, detail) {
                if (Components.isSuccessCode(status)) {
                    let storage = this_.mOfflineStorage.QueryInterface(Components.interfaces.calIOfflineStorage);
                    storage.modifyOfflineItem(detail, listener);
                } else if (listener) {
                    listener.onOperationComplete(this_, status, opType, id, detail);
                }
            }
        };
        this_.mOfflineStorage.modifyItem(newItem, oldItem, opListener);
    },


    /**
     * deleteItem(); required by calICalendar.idl
     * the actual deletion is done in deleteItemOrUseCache()
     *
     * @param aItem       item to delete
     * @param aListener   listener for method completion
     */

    deleteItem: function caldav_deleteItem(aItem, aListener) {
        return this.deleteItemOrUseCache(aItem, true, aListener);
    },

    deleteItemOrUseCache: function caldav_deleteItemOrUseCache(aItem, useCache, aListener){
        let this_ = this;

        let deleteListener = { //We need a listener because the original doDeleteItemOrUseCache would return null upon successful item deletion
            onGetResult: function(calendar, status, itemType, detail, count, items) {
                ASSERT(false, "unexpected!");
            },
            onOperationComplete: function(calendar, status, opType, id, detail) {
                aListener.onOperationComplete(calendar, status, opType, aItem.id, aItem);
            }
        };

        // If the item has an offline_flag associated with itself then it is better to
        // do offline deletion since the items will not be present in the
        // mItemInfoCache. The items will be reconciled whenever the server becomes available
        let opListener = {
            onGetResult: function(calendar, status, itemType, detail, count, items) {
            },
            onOperationComplete: function(calendar, status, opType, id, detail) {
                let offline_flag = detail;
                if((offline_flag == "c" || offline_flag == "m") && useCache) {
                    this_.deleteOfflineItem(aItem, deleteListener);
                } else {
                    this_.doDeleteItemOrUseCache(aItem, useCache, deleteListener, false);
                }
            }
        };
        let storage = this_.mOfflineStorage.QueryInterface(Components.interfaces.calIOfflineStorage);
        storage.getItemOfflineFlag(aItem, opListener);
    },
    /**
     * Deletes item from CalDAV store.
     *
     * @param aItem       item to delete
     * @param aListener   listener for method completion
     * @param useCache    flag to use the cache in case of failure
     * @param aIgnoreEtag ignore item etag
     * @param aFromInbox  delete from inbox rather than calendar
     * @param aUri        uri of item to delete
     * */
    doDeleteItemOrUseCache: function caldav_doDeleteItemOrUseCache(aItem, useCache, aListener, aIgnoreEtag, aFromInbox, aUri){
        if (aItem.id == null) {
            this.notifyOperationComplete(aListener,
                                         Components.results.NS_ERROR_FAILURE,
                                         Components.interfaces.calIOperationListener.DELETE,
                                         aItem.id,
                                         "ID doesn't exist for deleteItem");
            return;
        }

        let eventUri;
        if (aUri) {
            eventUri = aUri;
        } else if (aFromInbox || this.mItemInfoCache[aItem.id].isInboxItem) {
            eventUri = this.makeUri(this.mItemInfoCache[aItem.id].locationPath, this.mInboxUrl);
        } else {
            eventUri = this.makeUri(this.mItemInfoCache[aItem.id].locationPath);
        }

        let delListener = {};
        let thisCalendar = this;
        let realListener = aListener; // need to access from callback

        delListener.onStreamComplete =
        function caldav_dDI_del_onStreamComplete(aLoader, aContext, aStatus, aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            let status;
            try {
                status = request.responseStatus;
            } catch (ex) {
                status = Components.interfaces.calIErrors.DAV_REMOVE_ERROR;
            }

            // 204 = HTTP "No content"
            //
            if (status == 204 || status == 200) {
                if (!aFromInbox) {
                    if (thisCalendar.isCached) {
                        // the item is deleted in the storage calendar from calCachedCalendar
                        realListener.onOperationComplete(thisCalendar, status,
                                                         Components.interfaces.calIOperationListener.DELETE,
                                                         null, null);
                        //thisCalendar.mOfflineStorage.deleteItem(aItem, aListener);
                        thisCalendar.mOfflineStorage.deleteMetaData(aItem.id);
                    } else {
                        thisCalendar.mOfflineStorage.deleteItem(aItem, aListener);
                    }
                    let decodedHRef = decodeURIComponent(eventUri.path);
                    delete thisCalendar.mHrefIndex[decodedHRef];
                    delete thisCalendar.mItemInfoCache[aItem.id];
                    cal.LOG("CalDAV: Item deleted successfully from calendar" +
                            thisCalendar.name);
                }
            } else if (status == 412) {
                // item has either been modified or deleted by someone else
                // check to see which

                let httpchannel2 = cal.prepHttpChannel(eventUri,
                                                       null,
                                                       null,
                                                       thisCalendar);
                httpchannel2.requestMethod = "HEAD";
                cal.sendHttpRequest(cal.createStreamLoader(), httpchannel2, delListener2);
            } else if ((status >= 500 && status <= 510) && useCache) {
                LOG("[calDavCalendar] doDeleteItemOrUseCache recd status response of remote calendar unavailability. Putting entry in cache for a later try.");
                let opListener = {
                    //We should not return a success code since the listeners can delete the physical item in case of success
                    onGetResult: function(calendar, status, itemType, detail, count, items) {
                    },
                    onOperationComplete: function(calendar, status, opType, id, detail) {
                         aListener.onOperationComplete(calendar, Components.results.NS_ERROR_CONNECTION_REFUSED,
                                          Components.interfaces.calIOperationListener.GET, aItem.id, aItem);
                    }
                };
                thisCalendar.deleteOfflineItem(aItem, opListener);
            } else {
                let str;
                try {
                    str = cal.convertByteArray(aResult, aResultLength);
                } catch(e) {}
                cal.LOG("CalDAV: Unexpected status " + status +
                        " deleting item from " + thisCalendar.name +
                        ". Content:\n" + str);
                thisCalendar.reportDavError(Components.interfaces.calIErrors.DAV_REMOVE_ERROR);
            }
        };
        let delListener2 = {};
        delListener2.onStreamComplete =
            function caldav_dDI_del2_onStreamComplete(aLoader, aContext, aStatus, aResultLength, aResult) {
                let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
                let status = request.responseStatus;
                if (status == 404) {
                    // someone else already deleted it
                    return;
                } else if ((status >= 500 && status <= 510) && useCache) {
                    LOG("[calDavCalendar] doDeleteItemOrUseCache recd status response of remote calendar unavailability. Putting entry in cache for a later try.");
                    let opListener = {
                         //We should not return a success code since the listeners can delete the physical item in case of success
                         onGetResult: function(calendar, status, itemType, detail, count, items) {
                        },
                         onOperationComplete: function(calendar, status, opType, id, detail) {
                              aListener.onOperationComplete(calendar, Components.results.NS_ERROR_CONNECTION_REFUSED,
                                               Components.interfaces.calIOperationListener.GET, aItem.id, aItem);
                        }
                    };
                    thisCalendar.deleteOfflineItem(aItem, opListener);
                } else {
                    thisCalendar.promptOverwrite(CALDAV_DELETE_ITEM, aItem,
                                                 realListener, null);
                }
            };

        if (this.verboseLogging()) {
            cal.LOG("CalDAV: Deleting " + eventUri.spec);
        }

        let httpchannel = cal.prepHttpChannel(eventUri, null, null, this);
        if (!aIgnoreEtag) {
            httpchannel.setRequestHeader("If-Match",
                                         this.mItemInfoCache[aItem.id].etag,
                                         false);
        }
        httpchannel.requestMethod = "DELETE";

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, delListener);
    },

    deleteOfflineItem: function(item, listener) {
        /* We do not delete the item from the cache, as we will need it when reconciling the cache content and the server content. */
        let storage = this.mOfflineStorage.QueryInterface(Components.interfaces.calIOfflineStorage);
        storage.deleteOfflineItem(item, listener);
    },

    /**
     * Add an item to the target calendar
     *
     * @param href      Item href
     * @param calData   iCalendar string representation of the item
     * @param aUri      Base URI of the request
     * @param aListener Listener
     */
    addTargetCalendarItem : function caldav_addTargetCalendarItem(href,calData,aUri, etag, aListener) {
        let parser = Components.classes["@mozilla.org/calendar/ics-parser;1"]
                               .createInstance(Components.interfaces.calIIcsParser);
        let uriPathComponentLength = aUri.path.split("/").length;
        let resourcePath = this.ensurePath(href);
        try {
            parser.parseString(calData);
        } catch (e) {
            // Warn and continue.
            // TODO As soon as we have activity manager integration,
            // this should be replace with logic to notify that a
            // certain event failed.
            cal.WARN("Failed to parse item: " + response.toXMLString());
            return;
        }
        // with CalDAV there really should only be one item here
        let items = parser.getItems({});
        let propertiesList = parser.getProperties({});
        let method;
        for each (let prop in propertiesList) {
            if (prop.propertyName == "METHOD") {
                method = prop.value;
                break;
            }
        }
        let isReply = (method == "REPLY");
        let item = items[0];
        if (!item) {
            cal.WARN("Failed to parse item: " + calData);
            return;
        }

        item.calendar = this.superCalendar;
        if (isReply && this.isInbox(aUri.spec)) {
            if (this.hasScheduling) {
                this.processItipReply(item, resourcePath);
            }
            cal.WARN("REPLY method but calendar does not support scheduling");
            return;
        }

        // Strip of the same number of components as the request
        // uri's path has. This way we make sure to handle servers
        // that pass hrefs like /dav/user/Calendar while
        // the request uri is like /dav/user@example.org/Calendar.
        let resPathComponents = resourcePath.split("/");
        resPathComponents.splice(0, uriPathComponentLength - 1);
        let locationPath = decodeURIComponent(resPathComponents.join("/"));
        let isInboxItem = this.isInbox(aUri.spec);

        let hrefPath = this.ensurePath(href);
        if (this.mHrefIndex[hrefPath] &&
            !this.mItemInfoCache[item.id]) {
            // If we get here it means a meeting has kept the same filename
            // but changed its uid, which can happen server side.
            // Delete the meeting before re-adding it
            this.deleteTargetCalendarItem(hrefPath);
        }

        if (this.mItemInfoCache[item.id]) {
            this.mItemInfoCache[item.id].isNew = false;
        } else {
            this.mItemInfoCache[item.id] = { isNew: true };
        }
        this.mItemInfoCache[item.id].locationPath = locationPath;
        this.mItemInfoCache[item.id].isInboxItem = isInboxItem;

        this.mHrefIndex[hrefPath] = item.id;
        this.mItemInfoCache[item.id].etag = etag;
        if (this.mItemInfoCache[item.id].isNew) {
            this.mOfflineStorage.adoptItem(item, aListener);
        } else {
            this.mOfflineStorage.modifyItem(item, null, aListener);
        }

        if (this.isCached) {
            this.setMetaData(item.id, resourcePath, etag, isInboxItem);
        }
    },

    /**
     * Deletes an item from the target calendar
     *
     * @param path Path of the item to delete
     */
    deleteTargetCalendarItem: function caldav_deleteTargetCalendarItem(path) {
        let foundItem;
        let isDeleted = false;
        let getItemListener = {
            onGetResult: function deleteLocalItem_getItem_onResult(aCalendar,
                                                     aStatus,
                                                     aItemType,
                                                     aDetail,
                                                     aCount,
                                                     aItems) {

                foundItem = aItems[0];
            },
            onOperationComplete: function deleteLocalItem_getItem_onOperationComplete() {}
        };

        this.mOfflineStorage.getItem(this.mHrefIndex[path],
                                     getItemListener);
        // Since the target calendar's operations are synchronous, we can
        // safely set variables from this function.
        if (foundItem) {
            let wasInboxItem = this.mItemInfoCache[foundItem.id].isInboxItem;
            if ((wasInboxItem && this.isInbox(path)) ||
                (wasInboxItem === false && !this.isInbox(path))) {

                cal.LOG("CalDAV: deleting item: " + path + ", uid: " + foundItem.id);
                delete this.mHrefIndex[path];
                delete this.mItemInfoCache[foundItem.id];
                if (this.isCached) {
                    this.mOfflineStorage.deleteMetaData(foundItem.id);
                }
                this.mOfflineStorage.deleteItem(foundItem,
                                                getItemListener);
                isDeleted = true;
            }
        }
        return isDeleted;
    },

    /**
     * Perform tasks required after updating items in the calendar such as
     * notifying the observers and listeners
     *
     * @param aChangeLogListener    Change log listener
     * @param calendarURI           URI of the calendar whose items just got
     *                              changed
     */
    finalizeUpdatedItems: function calDav_finalizeUpdatedItems(aChangeLogListener, calendarURI) {
        if (this.isCached) {
            if (aChangeLogListener) {
                aChangeLogListener.onResult({ status: Components.results.NS_OK },
                                            Components.results.NS_OK);
            }
        } else {
            this.mObservers.notify("onLoad", [this]);
        }

        this.mFirstRefreshDone = true;
        while (this.mQueuedQueries.length) {
            let query = this.mQueuedQueries.pop();
            this.mOfflineStorage.getItems
                .apply(this.mOfflineStorage, query);
        }
        if (this.hasScheduling &&
            !this.isInbox(calendarURI.spec)) {
            this.pollInbox();
        }
    },

    /**
     * Notifies the caller that a get request has failed.
     *
     * @param errorMsg           Error message
     * @param aListener          (optional) Listener of the request
     * @param aChangeLogListener (optional)Listener for cached calendars
     */
    notifyGetFailed: function notifyGetFailed(errorMsg, aListener, aChangeLogListener) {
         cal.WARN("CalDAV: Get failed: " + errorMsg);
         if (this.isCached && aChangeLogListener) {
             aChangeLogListener.onResult({ status: Components.results.NS_ERROR_FAILURE },
                                         Components.results.NS_ERROR_FAILURE);
         }

         // Notify operation listener
         this.notifyOperationComplete(aListener,
                                      Components.results.NS_ERROR_FAILURE,
                                      Components.interfaces.calIOperationListener.GET,
                                      null,
                                      errorMsg);
         // If an error occurrs here, we also need to unqueue the
         // requests previously queued.
         while (this.mQueuedQueries.length) {
             let [,,,,listener] = this.mQueuedQueries.pop();
             try {
                 listener.onOperationComplete(this.superCalendar,
                                              Components.results.NS_ERROR_FAILURE,
                                              Components.interfaces.calIOperationListener.GET,
                                              null,
                                              errorMsg);
             } catch (e) {
                 cal.ERROR(e);
             }
         }
     },

    /**
     * Retrieves a specific item from the CalDAV store.
     * Use when an outdated copy of the item is in hand.
     *
     * @param aItem       item to fetch
     * @param aListener   listener for method completion
     */
    getUpdatedItem: function caldav_getUpdatedItem(aItem, aListener, aChangeLogListener) {

        if (aItem == null) {
            this.notifyOperationComplete(aListener,
                                         Components.results.NS_ERROR_FAILURE,
                                         Components.interfaces.calIOperationListener.GET,
                                         null,
                                         "passed in null item");
            return;
        }

        let locationPath = this.getItemLocationPath(aItem);
        let itemUri = this.makeUri(locationPath);

        let multiget = new multigetSyncHandler([itemUri.path],
                                               this,
                                               this.makeUri(),
                                               null,
                                               aListener,
                                               aChangeLogListener);
        multiget.doMultiGet();
    },

    // void getItem( in string id, in calIOperationListener aListener );
    getItem: function caldav_getItem(aId, aListener) {
        this.mOfflineStorage.getItem(aId, aListener);
    },

    // void getItems( in unsigned long aItemFilter, in unsigned long aCount,
    //                in calIDateTime aRangeStart, in calIDateTime aRangeEnd,
    //                in calIOperationListener aListener );
    getItems: function caldav_getItems(aItemFilter, aCount, aRangeStart,
                                       aRangeEnd, aListener) {
        if (this.isCached) {
            if (this.mOfflineStorage) {
                this.mOfflineStorage.getItems.apply(this.mOfflineStorage, arguments);
            } else {
                this.notifyOperationComplete(aListener,
                                             Components.results.NS_OK,
                                             Components.interfaces.calIOperationListener.GET,
                                             null,
                                             null);
            }
        } else {
            if (!this.mCheckedServerInfo) {
                this.mQueuedQueries.push(arguments);
            } else {
                this.mOfflineStorage.getItems.apply(this.mOfflineStorage, arguments);
            }
        }
    },

    safeRefresh: function caldav_safeRefresh(aChangeLogListener) {
        if (!this.mACLEntry) {
            let thisCalendar = this;
            let opListener = {
                onGetResult: function(calendar, status, itemType, detail, count, items) {
                    ASSERT(false, "unexpected!");
                },
                onOperationComplete: function(opCalendar, opStatus, opType, opId, opDetail) {
                    thisCalendar.mACLEntry = opDetail;
                    thisCalendar.safeRefresh(aChangeLogListener);
                }
            };

            let aclMgr = Components.classes["@inverse.ca/calendar/caldav-acl-manager;1"]
                                   .getService(Components.interfaces.calICalDAVACLManager);
            aclMgr.getCalendarEntry(this, opListener);
            return;
        }

        this.ensureTargetCalendar();

        if (this.mAuthScheme == "Digest") {
            // the auth could have timed out and be in need of renegotiation
            // we can't risk several calendars doing this simultaneously so
            // we'll force the renegotiation in a sync query, using OPTIONS to keep
            // it quick
            let headchannel = cal.prepHttpChannel(this.makeUri(), null, null, this);
            headchannel.requestMethod = "OPTIONS";
            headchannel.open();
            headchannel.QueryInterface(Components.interfaces.nsIHttpChannel);
            try {
              if (headchannel.responseStatus != 200) {
                throw "OPTIONS returned unexpected status code: " + headchannel.responseStatus;
              }
            }
            catch (e) {
                cal.WARN("CalDAV: Exception: " + e);
                if (aChangeLogListener) {
                    aChangeLogListener.onResult({ status: Components.results.NS_ERROR_FAILURE },
                                                Components.results.NS_ERROR_FAILURE);
                }
            }
        }

        // Call getUpdatedItems right away if its the first refresh
        // *OR* if webdav Sync is enabled (It is redundant to send a request
        // to get the collection tag (getctag) on a calendar if it supports
        // webdav sync, the sync request will only return data if something
        // changed).
        if (!this.mCtag || !this.mFirstRefreshDone || this.mHasWebdavSyncSupport ) {
            this.getUpdatedItems(this.calendarUri, aChangeLogListener);
            return;
        }
        let thisCalendar = this;

        let D = new Namespace("D", "DAV:");
        let CS = new Namespace("CS", "http://calendarserver.org/ns/");
        let queryXml = <D:propfind xmlns:D={D} xmlns:CS={CS}>
                        <D:prop>
                            <CS:getctag/>
                        </D:prop>
                        </D:propfind>;
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send(" + this.makeUri().spec + "): " + queryXml);
        }
        let httpchannel = cal.prepHttpChannel(this.makeUri(),
                                              queryXml,
                                              "text/xml; charset=utf-8",
                                              this);
        httpchannel.setRequestHeader("Depth", "0", false);
        httpchannel.requestMethod = "PROPFIND";

        let streamListener = {};
        streamListener.onStreamComplete =
            function safeRefresh_safeRefresh_onStreamComplete(aLoader, aContext, aStatus, aResultLength, aResult) {
            let request;
            try {
                request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
                cal.LOG("CalDAV: Status " + request.responseStatus +
                        " checking ctag for calendar " + thisCalendar.name);

                if (request.responseStatus == 404) {
                    cal.LOG("CalDAV: Disabling calendar " + thisCalendar.name +
                            " due to 404");
                    if (thisCalendar.isCached && aChangeLogListener) {
                        aChangeLogListener.onResult({ status: Components.results.NS_ERROR_FAILURE },
                                                    Components.results.NS_ERROR_FAILURE);
                    }
                    return;
                } else if (request.responseStatus == 207 && thisCalendar.disabled) {
                    // Looks like the calendar is there again, check its resource
                    // type first.
                    thisCalendar.checkDavResourceType(aChangeLogListener);
                    return;
                }
            } catch (ex) {
                cal.LOG("CalDAV: Error without status on checking ctag for calendar " +
                        thisCalendar.name);
                cal.LOG("  exception: " + ex);
                if (thisCalendar.isCached && aChangeLogListener) {
                    aChangeLogListener.onResult({ status: Components.results.NS_OK },
                                                Components.results.NS_OK);
                }
                return;
            }

            let str = cal.convertByteArray(aResult, aResultLength);
            if (!str) {
                cal.LOG("CalDAV: Failed to get ctag from server for calendar " +
                        thisCalendar.name);
            } else if (thisCalendar.verboseLogging()) {
                cal.LOG("CalDAV: recv: " + str);
            }

            let multistatus;
            try {
                multistatus = cal.safeNewXML(str);
            } catch (ex) {
                cal.LOG("CalDAV: Failed to get ctag from server for calendar " +
                        thisCalendar.name);
                if (thisCalendar.isCached && aChangeLogListener) {
                    aChangeLogListener.onResult({ status: Components.results.NS_OK },
                                                Components.results.NS_OK);
                }
                return;
            }

            let ctag = multistatus..CS::getctag.toString();
            if (!ctag.length || ctag != thisCalendar.mCtag) {
                // ctag mismatch, need to fetch calendar-data
                thisCalendar.mCtag = ctag;
                thisCalendar.saveCalendarProperties();
                thisCalendar.getUpdatedItems(thisCalendar.calendarUri,
                                             aChangeLogListener);
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: ctag mismatch on refresh, fetching data for " +
                            "calendar " + thisCalendar.name);

                }
            } else {
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: ctag matches, no need to fetch data for " +
                            "calendar " + thisCalendar.name);
                }

                if (thisCalendar.isCached && aChangeLogListener) {
                    aChangeLogListener.onResult({ status: Components.results.NS_OK },
                                                Components.results.NS_OK);
                }
                else {
                    thisCalendar.mObservers.notify("onLoad", [thisCalendar]);
                }

                // we may still need to poll the inbox
                if (thisCalendar.firstInRealm()) {
                    thisCalendar.pollInbox();
                }
            }
        };
        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    refresh: function caldav_refresh() {
        this.replayChangesOn(null);
    },

    firstInRealm: function caldav_firstInRealm() {
        let calendars = getCalendarManager().getCalendars({});
        for (let i = 0; i < calendars.length ; i++) {
            if (calendars[i].type != "caldav") {
                continue;
            }
            // XXX We should probably expose the inner calendar via an
            // interface, but for now use wrappedJSObject.
            let calendar = calendars[i].wrappedJSObject;
            if (calendar.mUncachedCalendar) {
                calendar = calendar.mUncachedCalendar;
            }
            if (calendar.uri.prePath == this.uri.prePath &&
                calendar.authRealm == this.mAuthRealm) {
                if (calendar.id == this.id) {
                    return true;
                }
                break;
            }
        }
        return false;
    },

    prepRefresh: function caldav_prepRefresh() {

        let itemTypes = this.supportedItemTypes.concat([]);
        let typesCount = itemTypes.length;
        let refreshEvent = {};
        refreshEvent.itemTypes = itemTypes;
        refreshEvent.typesCount = typesCount;
        refreshEvent.queryStatuses = [];
        refreshEvent.itemsNeedFetching = [];
        refreshEvent.itemsReported = {};
        refreshEvent.uri = this.calendarUri;

        return refreshEvent;
    },

    /**
     * Get updated items
     *
     * @param aUri                  The uri to request the items from.
     *                                NOTE: This must be the uri without any uri
     *                                     params. They will be appended in this
     *                                     function.
     * @param aChangeLogListener    (optional) The listener to notify for cached
     *                                         calendars.
     */
    getUpdatedItems: function caldav_getUpdatedItems(aUri, aChangeLogListener) {
         if (this.disabled) {
            // See https://bugzilla.mozilla.org/show_bug.cgi?id=470934
            this.reenable(aChangeLogListener);
            return;
        }

		if (this.disabled) {
            // check if maybe our calendar has become available
            this.checkDavResourceType(aChangeLogListener);
            return;
        }

        if (this.mHasWebdavSyncSupport) {
            let webDavSync = new webDavSyncHandler(this,aUri,aChangeLogListener);
            webDavSync.doWebDAVSync();
            return;
        }

        let C = new Namespace("C", "urn:ietf:params:xml:ns:caldav");
        let D = new Namespace("D", "DAV:");
        default xml namespace = C;

        let queryXml = <D:propfind xmlns:D="DAV:">
                        <D:prop>
                            <D:getcontenttype/>
                            <D:resourcetype/>
                            <D:getetag/>
                        </D:prop>
                       </D:propfind>;

        let queryString = xmlHeader + queryXml.toXMLString();
        let requestUri = this.makeUri(null, aUri);
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send(" + requestUri.spec + "): " + queryString);
        }

        let httpchannel = cal.prepHttpChannel(requestUri,
                                              queryString,
                                              "text/xml; charset=utf-8",
                                              this);
        httpchannel.requestMethod = "PROPFIND";
        httpchannel.setRequestHeader("Depth", "1", false);

        // Submit the request
        let streamListener = new etagsHandler(this, aUri, aChangeLogListener);
        httpchannel.asyncOpen(streamListener, httpchannel);
    },

    /**
     * @see nsIInterfaceRequestor
     * @see calProviderUtils.jsm
     */
    getInterface: cal.InterfaceRequestor_getInterface,

    //
    // Helper functions
    //

    /**
     * Checks that the calendar URI exists and is a CalDAV calendar. This is the
     * beginning of a chain of asynchronous calls. This function will, when
     * done, call the next function related to checking resource type, server
     * capabilties, etc.
     *
     * checkDavResourceType                        * You are here
     * checkServerCaps
     * findPrincipalNS
     * checkPrincipalsNameSpace
     * completeCheckServerInfo
     */
    checkDavResourceType: function caldav_checkDavResourceType(aChangeLogListener) {
        this.ensureTargetCalendar();

        let resourceTypeXml = null;
        let resourceType = kDavResourceTypeNone;
        let thisCalendar = this;

        let C = new Namespace("C", "urn:ietf:params:xml:ns:caldav");
        let D = new Namespace("D", "DAV:");
        let CS = new Namespace("CS", "http://calendarserver.org/ns/");
        let queryXml = <D:propfind xmlns:D="DAV:" xmlns:CS={CS} xmlns:C={C}>
                        <D:prop>
                            <D:resourcetype/>
                            <D:owner/>
                            <D:supported-report-set/>
                            <C:supported-calendar-component-set/>
                            <CS:getctag/>
                        </D:prop>
                        </D:propfind>;
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send: " + queryXml);
        }
        let httpchannel = cal.prepHttpChannel(this.makeUri(),
                                              queryXml,
                                              "text/xml; charset=utf-8",
                                              this);
        httpchannel.setRequestHeader("Depth", "0", false);
        httpchannel.requestMethod = "PROPFIND";

        let streamListener = {};

        streamListener.onStreamComplete =
            function checkDavResourceType_oSC(aLoader, aContext, aStatus, aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            try {
                cal.LOG("CalDAV: Status " + request.responseStatus +
                        " on initial PROPFIND for calendar " + thisCalendar.name);
            } catch (ex) {
                cal.LOG("CalDAV: Error without status on initial PROPFIND for calendar " +
                        thisCalendar.name);
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.interfaces.calIErrors.DAV_NOT_DAV);
                return;
            }
            let wwwauth;
            try {
                wwwauth = request.getRequestHeader("Authorization");
                thisCalendar.mAuthScheme = wwwauth.split(" ")[0];
            } catch (ex) {
                // no auth header could mean a public calendar
                thisCalendar.mAuthScheme = "none";
            }

            if (thisCalendar.mUriParams) {
                thisCalendar.mAuthScheme = "Ticket";
            }
            cal.LOG("CalDAV: Authentication scheme for " + thisCalendar.name +
                    " is " + thisCalendar.mAuthScheme);
            // we only really need the authrealm for Digest auth
            // since only Digest is going to time out on us
            if (thisCalendar.mAuthScheme == "Digest") {
                let realmChop = wwwauth.split("realm=\"")[1];
                thisCalendar.mAuthRealm = realmChop.split("\", ")[0];
                cal.LOG("CalDAV: realm " + thisCalendar.mAuthRealm);
            }

            let str = cal.convertByteArray(aResult, aResultLength);
            if (!str || request.responseStatus == 404) {
                // No response, or the calendar no longer exists.
                cal.LOG("CalDAV: Failed to determine resource type for" +
                        thisCalendar.name);
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.interfaces.calIErrors.DAV_NOT_DAV);
                return;
            } else if (thisCalendar.verboseLogging()) {
                cal.LOG("CalDAV: recv: " + str);
            }

            let multistatus;
            try {
                multistatus = cal.safeNewXML(str);
            } catch (ex) {
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.interfaces.calIErrors.DAV_NOT_DAV);
                return;
            }

            // check for webdav-sync capability
            // http://tools.ietf.org/html/draft-daboo-webdav-sync
            if (multistatus..D::["supported-report-set"]..D::["sync-collection"].length() > 0) {
                LOG("CalDAV: Collection has webdav sync support");
                thisCalendar.mHasWebdavSyncSupport = true;
            }

            // check for server-side ctag support only if webdav sync is not available
            let ctag = multistatus..CS::["getctag"].toString();
            if (!thisCalendar.mHasWebdavSyncSupport && ctag.length) {
                // We compare the stored ctag with the one we just got, if
                // they don't match, we update the items in safeRefresh.
                if (ctag == thisCalendar.mCtag) {
                    thisCalendar.mFirstRefreshDone = true;
                }

                thisCalendar.mCtag = ctag;
                thisCalendar.saveCalendarProperties();
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: initial ctag " + ctag + " for calendar " +
                            thisCalendar.name);
                }
            }

            supportedComponentsXml = multistatus..C::["supported-calendar-component-set"];
            // use supported-calendar-component-set if the server supports it; some do not
            if (supportedComponentsXml.C::comp.length() > 0) {
                thisCalendar.mSupportedItemTypes.length = 0;
                for each (let sc in supportedComponentsXml.C::comp) {
                    let comp = sc.@name.toString();
                    if (thisCalendar.mGenerallySupportedItemTypes.indexOf(comp) >= 0) {
                        cal.LOG("Adding supported item: " + comp + " for calendar: " + thisCalendar.name);
                        thisCalendar.mSupportedItemTypes.push(comp);
                    }
                }
            }

            // check if owner is specified; might save some work
            thisCalendar.mPrincipalUrl = multistatus..D::["owner"]..D::href.toString() || null;

            let resourceTypeXml = multistatus..D::["resourcetype"];
            if (resourceTypeXml.length() == 0) {
                resourceType = kDavResourceTypeNone;
            } else if (resourceTypeXml.toString().indexOf("calendar") != -1) {
                resourceType = kDavResourceTypeCalendar;
            } else if (resourceTypeXml.toString().indexOf("collection") != -1) {
                resourceType = kDavResourceTypeCollection;
            }

            // specialcasing so as not to break older SOGo revs. Remove when
            // versions with fixed principal-URL PROPFIND bug are out there
            if (resourceTypeXml.toString().indexOf("groupdav") != -1) {
                thisCalendar.mPrincipalUrl = null;
            }
            // end of SOGo specialcasing

            if (resourceType == kDavResourceTypeNone &&
                !thisCalendar.disabled) {
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.interfaces.calIErrors.DAV_NOT_DAV);
                return;
            }

            if ((resourceType == kDavResourceTypeCollection) &&
                !thisCalendar.disabled) {
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.interfaces.calIErrors.DAV_DAV_NOT_CALDAV);
                return;
            }

            // if this calendar was previously offline we want to recover
            if ((resourceType == kDavResourceTypeCalendar) &&
                thisCalendar.disabled) {
                thisCalendar.disabled = false;
                thisCalendar.readOnly = false;
            }

            thisCalendar.setCalHomeSet();
            thisCalendar.checkServerCaps(aChangeLogListener);
        };
        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    /**
     * Checks server capabilities.
     *
     * checkDavResourceType
     * checkServerCaps                              * You are here
     * findPrincipalNS
     * checkPrincipalsNameSpace
     * completeCheckServerInfo
     */
    checkServerCaps: function caldav_checkServerCaps(aChangeLogListener) {
        let homeSet = this.makeUri(null, this.mCalHomeSet);
        let thisCalendar = this;

        let httpchannel = cal.prepHttpChannel(homeSet, null, null, this);

        httpchannel.requestMethod = "OPTIONS";
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send: OPTIONS " + homeSet.spec);
        }

        let streamListener = {};
        streamListener.onStreamComplete =
            function checkServerCaps_oSC(aLoader, aContext, aStatus,
                                         aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            if (request.responseStatus != 200) {
                cal.LOG("CalDAV: Unexpected status " + request.responseStatus +
                        " while querying options " + thisCalendar.name);
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.results.NS_ERROR_FAILURE);
                return;
            }

            let dav = null;
            try {
                dav = request.getResponseHeader("DAV");
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: DAV header: " + dav);
                }
            } catch (ex) {
                cal.LOG("CalDAV: Error getting DAV header for " + thisCalendar.name +
                        ", status " + request.responseStatus +
                        ", data: " + cal.convertByteArray(aResult, aResultLength));

            }
            // Google does not yet support OPTIONS but does support scheduling
            // so we'll spoof the DAV header until Google gets fixed
            if (thisCalendar.calendarUri.host == "www.google.com") {
                dav = "calendar-schedule";
                // Google also reports an inbox URL distinct from the calendar
                // URL but a) doesn't use it and b) 405s on etag queries to it
                thisCalendar.mShouldPollInbox = false;
            }
            if (dav && dav.indexOf("calendar-auto-schedule") != -1) {
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: Calendar " + thisCalendar.name +
                            " supports calendar-auto-schedule");
                }
                thisCalendar.hasAutoScheduling = true;
                // leave outbound inbox/outbox scheduling off
            } else if (dav && dav.indexOf("calendar-schedule") != -1) {
                if (thisCalendar.verboseLogging()) {
                    cal.LOG("CalDAV: Calendar " + thisCalendar.name +
                            " generally supports calendar-schedule");
                }
                thisCalendar.hasScheduling = true;
            }

            if (thisCalendar.hasAutoScheduling || (dav && dav.indexOf("calendar-schedule") != -1)) {
                // XXX - we really shouldn't register with the fb service
                // if another calendar with the same principal-URL has already
                // done so. We also shouldn't register with the fb service if we
                // don't have an outbox.
                getFreeBusyService().addProvider(thisCalendar);
                thisCalendar.findPrincipalNS(aChangeLogListener);
            } else {
                cal.LOG("CalDAV: Server does not support CalDAV scheduling.");
                thisCalendar.completeCheckServerInfo(aChangeLogListener);
            }
        };

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    /**
     * Locates the principal namespace. This function should soely be called
     * from checkServerCaps to find the principal namespace.
     *
     * checkDavResourceType
     * checkServerCaps
     * findPrincipalNS                              * You are here
     * checkPrincipalsNameSpace
     * completeCheckServerInfo
     */
    findPrincipalNS: function caldav_findPrincipalNS(aChangeLogListener) {
        if (this.principalUrl) {
            // We already have a principal namespace, use it.
            this.checkPrincipalsNameSpace([this.principalUrl],
                                          aChangeLogListener);
            return;
        }

        let homeSet = this.makeUri(null, this.mCalHomeSet);
        let thisCalendar = this;

        let D = new Namespace("D", "DAV:");
        let queryXml =
            <D:propfind xmlns:D="DAV:">
                <D:prop>
                    <D:principal-collection-set/>
                </D:prop>
            </D:propfind>;

        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send: " + homeSet.spec + "\n"  + queryXml);
        }
        let httpchannel = cal.prepHttpChannel(homeSet,
                                              queryXml,
                                              "text/xml; charset=utf-8",
                                              this);

        httpchannel.setRequestHeader("Depth", "0", false);
        httpchannel.requestMethod = "PROPFIND";

        let streamListener = {};
        streamListener.onStreamComplete =
            function findInOutboxes_oSC(aLoader, aContext, aStatus,
                                         aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            if (request.responseStatus != 207) {
                cal.LOG("CalDAV: Unexpected status " + request.responseStatus +
                    " while querying principal namespace for " + thisCalendar.name);
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.results.NS_ERROR_FAILURE);
                return;
            }

            let str = cal.convertByteArray(aResult, aResultLength);
            if (!str) {
                cal.LOG("CalDAV: Failed to propstat principal namespace for " + thisCalendar.name);
                thisCalendar.completeCheckServerInfo(aChangeLogListener,
                                                     Components.results.NS_ERROR_FAILURE);
                return;
            } else if (thisCalendar.verboseLogging()) {
                cal.LOG("CalDAV: recv: " + str);
            }

            let multistatus = cal.safeNewXML(str);
            let pcs = multistatus..D::["principal-collection-set"]..D::href;
            let nsList = [];
            for (let ns in pcs) {
                let nsString = pcs[ns].toString();
                let nsPath = thisCalendar.ensurePath(nsString);
                nsList.push(nsPath);
            }

            thisCalendar.checkPrincipalsNameSpace(nsList, aChangeLogListener);
        };

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    /**
     * Checks the principals namespace for scheduling info. This function should
     * soely be called from findPrincipalNS
     *
     * checkDavResourceType
     * checkServerCaps
     * findPrincipalNS
     * checkPrincipalsNameSpace                     * You are here
     * completeCheckServerInfo
     *
     * @param aNameSpaceList    List of available namespaces
     */
    checkPrincipalsNameSpace: function caldav_checkPrincipalsNameSpace(aNameSpaceList, aChangeLogListener) {
        let thisCalendar = this;
        function doesntSupportScheduling() {
            thisCalendar.hasScheduling = false;
            thisCalendar.mInboxUrl = null;
            thisCalendar.mOutboxUrl = null;
            thisCalendar.completeCheckServerInfo(aChangeLogListener);
        }

        if (!aNameSpaceList.length) {
            if (this.verboseLogging()) {
                cal.LOG("CalDAV: principal namespace list empty, calendar " +
                        this.name + " doesn't support scheduling");
            }
            doesntSupportScheduling();
            return;
        }

        // Remove trailing slash, if its there
        let homePath = this.mCalHomeSet.path.replace(/\/$/,"");

        let C = new Namespace("C", "urn:ietf:params:xml:ns:caldav");
        let D = new Namespace("D", "DAV:");
        default xml namespace = C;

        let queryXml;
        let queryMethod;
        let queryDepth;
        if (this.mPrincipalUrl) {
            queryXml = <D:propfind xmlns:D="DAV:"
                                   xmlns:C="urn:ietf:params:xml:ns:caldav">
                <D:prop>
                    <C:calendar-home-set/>
                    <C:calendar-user-address-set/>
                    <C:schedule-inbox-URL/>
                    <C:schedule-outbox-URL/>
                </D:prop>
            </D:propfind>;
            queryMethod = "PROPFIND";
            queryDepth = 0;
        } else {
            queryXml = <D:principal-property-search xmlns:D="DAV:"
                                                    xmlns:C="urn:ietf:params:xml:ns:caldav">
            <D:property-search>
                <D:prop>
                    <C:calendar-home-set/>
                </D:prop>
                <D:match>{homePath}</D:match>
            </D:property-search>
                <D:prop>
                    <C:calendar-home-set/>
                    <C:calendar-user-address-set/>
                    <C:schedule-inbox-URL/>
                    <C:schedule-outbox-URL/>
                </D:prop>
            </D:principal-property-search>;
            queryMethod = "REPORT";
            queryDepth = 1;
        }

        // We want a trailing slash, ensure it.
        let nsUri = this.calendarUri.clone();
        let nextNS = aNameSpaceList.pop().replace(/([^\/])$/, "$1/");
        let requestUri;
        // nextNS could be either a spec or a path
        if (nextNS.charAt(0) == "/") {
            nsUri.path = nextNS;
            requestUri = this.makeUri(null, nsUri);
        } else {
            requestUri = makeURL(nextNS);
        }


        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send: " + queryMethod + " " + requestUri.spec + "\n" + queryXml);
        }

        let httpchannel = cal.prepHttpChannel(requestUri,
                                              queryXml,
                                              "text/xml; charset=utf-8",
                                              this);

        httpchannel.requestMethod = queryMethod;
        if (queryDepth == 0) {
            // Set header, doing this for Depth: 1 is not needed since thats the
            // default.
            httpchannel.setRequestHeader("Depth", "0", false);
        }

        let streamListener = {};
        streamListener.onStreamComplete =
            function caldav_cPNS_oSC(aLoader, aContext, aStatus,
                                         aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            let str = cal.convertByteArray(aResult, aResultLength);
            if (!str) {
                cal.LOG("CalDAV: Failed to report principals namespace for " + thisCalendar.name);
                doesntSupportScheduling();
                return;
            } else if (thisCalendar.verboseLogging()) {
                cal.LOG("CalDAV: recv: " + str);
            }

            if (request.responseStatus != 207) {
                cal.LOG("CalDAV: Bad response to in/outbox query, status " +
                    request.responseStatus);
                doesntSupportScheduling();
                return;
            }

            let multistatus = cal.safeNewXML(str);
            let multistatusLength = multistatus.*::response.length();

            for each (let response in multistatus.*::response) {
                let responseCHS = null;
                try {
                    responseCHS = response..*::["calendar-home-set"]..*::href[0]
                                          .toString().replace(/([^\/])$/, "$1/");
                } catch (ex) {}

                if (multistatusLength > 1 &&
                    (responseCHS != thisCalendar.mCalHomeSet.path &&
                     responseCHS != thisCalendar.mCalHomeSet.spec)) {
                    // If there are multiple home sets, then we need to match
                    // the home url. If there is only one, we can assume its the
                    // correct one, even if the home set doesn't quite match.
                    continue;
                }
                for each (let addrHref in response..*::["calendar-user-address-set"]..*::href) {
                    if (addrHref.toString().substr(0, 7).toLowerCase() == "mailto:") {
                        thisCalendar.mCalendarUserAddress = addrHref.toString();
                    }
                }
                let ibUrl = thisCalendar.mUri.clone();
                try {
                    ibUrl.path = thisCalendar.ensurePath(response..*::["schedule-inbox-URL"]..*::href[0].toString());
                } catch (ex) {
                    // most likely this is a Kerio server that omits the "href"
                    ibUrl.path = thisCalendar.ensurePath(response..*::["schedule-inbox-URL"].toString());
                }

                // Make sure the inbox uri has a / at the end, as we do with the
                // calendarUri.
                if (ibUrl.path.charAt(ibUrl.path.length - 1) != '/') {
                    ibUrl.path += "/";
                }

                thisCalendar.mInboxUrl = ibUrl;
                if (thisCalendar.calendarUri.spec == ibUrl.spec) {
                    // If the inbox matches the calendar uri (i.e SOGo), then we
                    // don't need to poll the inbox.
                    thisCalendar.mShouldPollInbox = false;
                }

                let obUrl = thisCalendar.mUri.clone();
                try {
                    obUrl.path = thisCalendar.ensurePath(response..*::["schedule-outbox-URL"]..*::href[0].toString());
                } catch (ex) {
                    // most likely this is a Kerio server that omits the "href"
                    obUrl.path = thisCalendar.ensurePath(response..*::["schedule-outbox-URL"].toString());
                }

                // Make sure the outbox uri has a / at the end, as we do with
                // the calendarUri.
                if (obUrl.path.charAt(obUrl.path.length - 1) != '/') {
                    obUrl.path += "/";
                }

                thisCalendar.mOutboxUrl = obUrl;
            }

            if (!thisCalendar.calendarUserAddress ||
                !thisCalendar.mInboxUrl ||
                !thisCalendar.mOutboxUrl) {
                if (aNameSpaceList.length) {
                    // Check the next namespace to find the info we need.
                    thisCalendar.checkPrincipalsNameSpace(aNameSpaceList, aChangeLogListener);
                } else {
                    if (thisCalendar.verboseLogging()) {
                        cal.LOG("CalDAV: principal namespace list empty, calendar " +
                                thisCalendar.name + " doesn't support scheduling");
                    }
                    doesntSupportScheduling();
                }
            } else {
                // We have everything, complete.
                thisCalendar.completeCheckServerInfo(aChangeLogListener);
            }
        };

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    /**
     * This is called to complete checking the server info. It should be the
     * final call when checking server options. This will either report the
     * error or if it is a success then refresh the calendar.
     *
     * checkDavResourceType
     * checkServerCaps
     * findPrincipalNS
     * checkPrincipalsNameSpace
     * completeCheckServerInfo                      * You are here
     */
    completeCheckServerInfo: function caldav_completeCheckServerInfo(aChangeLogListener, aError) {
        if (Components.isSuccessCode(aError)) {
            // "undefined" is a successcode, so all is good
            this.saveCalendarProperties();
            this.mCheckedServerInfo = true;
            this.setProperty("currentStatus", Components.results.NS_OK);

            if (this.isCached) {
                this.safeRefresh(aChangeLogListener);
            } else {
                this.refresh();
            }
        } else {
            this.reportDavError(aError);
            if (this.isCached && aChangeLogListener) {
                aChangeLogListener.onResult({ status: Components.results.NS_ERROR_FAILURE },
                                            Components.results.NS_ERROR_FAILURE);
            }
        }
    },

    /**
     * Called to report a certain DAV error. Strings and modification type are
     * handled here.
     */
    reportDavError: function caldav_reportDavError(aErrNo) {
        let mapError = {};
        mapError[Components.interfaces.calIErrors.DAV_NOT_DAV] = "dav_notDav";
        mapError[Components.interfaces.calIErrors.DAV_DAV_NOT_CALDAV] = "dav_davNotCaldav";
        mapError[Components.interfaces.calIErrors.DAV_PUT_ERROR] = "itemPutError";
        mapError[Components.interfaces.calIErrors.DAV_REMOVE_ERROR] = "itemDeleteError";
        mapError[Components.interfaces.calIErrors.DAV_REPORT_ERROR] = "disabledMode";

        let mapModification = {};
        mapModification[Components.interfaces.calIErrors.DAV_NOT_DAV] = false;
        mapModification[Components.interfaces.calIErrors.DAV_DAV_NOT_CALDAV] = false;
        mapModification[Components.interfaces.calIErrors.DAV_PUT_ERROR] = true;
        mapModification[Components.interfaces.calIErrors.DAV_REMOVE_ERROR] = true;
        mapModification[Components.interfaces.calIErrors.DAV_REPORT_ERROR] = false;

        let message = mapError[aErrNo];
        let modificationError = mapModification[aErrNo];

        if (!message) {
            // If we don't have a message for this, then its not important
            // enough to notify.
            return;
        }

        this.readOnly = true;
        this.disabled = true;
if (!message) {
            // If we don't have a message for this, then its not important
            // enough to notify.
            return;
        }

        this.notifyError(aErrNo,
                         calGetString("calendar", message , [this.mUri.spec]));
        this.notifyError(modificationError
                         ? Components.interfaces.calIErrors.MODIFICATION_FAILED
                         : Components.interfaces.calIErrors.READ_FAILED,
                         "");
    },

    //
    // calIFreeBusyProvider interface
    //

    getFreeBusyIntervals: function caldav_getFreeBusyIntervals(
        aCalId, aRangeStart, aRangeEnd, aBusyTypes, aListener) {

        // We explicitly don't check for hasScheduling here to allow free-busy queries
        // even in case sched is turned off.
        if (!this.outboxUrl || !this.calendarUserAddress) {
            cal.LOG("CalDAV: Calendar " + this.name + " doen't support scheduling;" +
                    " freebusy query not possible");
            aListener.onResult(null, null);
            return;
        }

        if (!this.firstInRealm()) {
            // don't spam every known outbox with freebusy queries
            aListener.onResult(null, null);
            return;
        }

        // We tweak the organizer lookup here: If e.g. scheduling is turned off, then the
        // configured email takes place being the organizerId for scheduling which need
        // not match against the calendar-user-address:
        let orgId = this.getProperty("organizerId");
        if (orgId && orgId.toLowerCase() == aCalId.toLowerCase()) {
            aCalId = this.calendarUserAddress; // continue with calendar-user-address
        }

        // the caller prepends MAILTO: to calid strings containing @
        // but apple needs that to be mailto:
        let aCalIdParts = aCalId.split(":");
        aCalIdParts[0] = aCalIdParts[0].toLowerCase();

        if (aCalIdParts[0] != "mailto"
            && aCalIdParts[0] != "http"
            && aCalIdParts[0] != "https" ) {
            aListener.onResult(null, null);
            return;
        }
        let mailto_aCalId = aCalIdParts.join(":");

        let thisCalendar = this;

        let organizer = this.calendarUserAddress;

        let fbQuery = getIcsService().createIcalComponent("VCALENDAR");
        calSetProdidVersion(fbQuery);
        let prop = getIcsService().createIcalProperty("METHOD");
        prop.value = "REQUEST";
        fbQuery.addProperty(prop);
        let fbComp = getIcsService().createIcalComponent("VFREEBUSY");
        fbComp.stampTime = now().getInTimezone(UTC());
        prop = getIcsService().createIcalProperty("ORGANIZER");
        prop.value = organizer;
        fbComp.addProperty(prop);
        fbComp.startTime = aRangeStart.getInTimezone(UTC());
        fbComp.endTime = aRangeEnd.getInTimezone(UTC());
        fbComp.uid = getUUID();
        prop = getIcsService().createIcalProperty("ATTENDEE");
        prop.setParameter("PARTSTAT", "NEEDS-ACTION");
        prop.setParameter("ROLE", "REQ-PARTICIPANT");
        prop.setParameter("CUTYPE", "INDIVIDUAL");
        prop.value = mailto_aCalId;
        fbComp.addProperty(prop);
        fbQuery.addSubcomponent(fbComp);
        fbQuery = fbQuery.serializeToICS();
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send (Originator=" + organizer +
                    ",Recipient=" + mailto_aCalId + "): " + fbQuery);
        }

        let httpchannel = cal.prepHttpChannel(this.makeUri(null, this.outboxUrl),
                                              fbQuery,
                                              "text/calendar; charset=utf-8",
                                              this);
        httpchannel.requestMethod = "POST";
        httpchannel.setRequestHeader("Originator", organizer, false);
        httpchannel.setRequestHeader("Recipient", mailto_aCalId, false);

        let streamListener = {};

        streamListener.onStreamComplete =
            function caldav_GFBI_oSC(aLoader, aContext, aStatus,
                                         aResultLength, aResult) {
            let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
            let str = cal.convertByteArray(aResult, aResultLength);
            if (!str) {
                cal.LOG("CalDAV: Failed to parse freebusy response from " + thisCalendar.name);
            } else if (thisCalendar.verboseLogging()) {
                cal.LOG("CalDAV: recv: " + str);
            }

            if (request.responseStatus == 200) {
                let periodsToReturn = [];
                let CalPeriod = new Components.Constructor("@mozilla.org/calendar/period;1",
                                                           "calIPeriod");
                let fbTypeMap = {};
                fbTypeMap["FREE"] = calIFreeBusyInterval.FREE;
                fbTypeMap["BUSY"] = calIFreeBusyInterval.BUSY;
                fbTypeMap["BUSY-UNAVAILABLE"] = calIFreeBusyInterval.BUSY_UNAVAILABLE;
                fbTypeMap["BUSY-TENTATIVE"] = calIFreeBusyInterval.BUSY_TENTATIVE;
                let C = new Namespace("C", "urn:ietf:params:xml:ns:caldav");
                let D = new Namespace("D", "DAV:");

                let response = cal.safeNewXML(str);
                let status = response..C::response..C::["request-status"];
                if (status.substr(0,1) != 2) {
                    cal.LOG("CalDAV: Got status " + status + " in response to " +
                            "freebusy query for " + thisCalendar.name) ;
                    aListener.onResult(null, null);
                    return;
                }
                if (status.substr(0,3) != "2.0") {
                    cal.LOG("CalDAV: Got status " + status + " in response to " +
                            "freebusy query for" + thisCalendar.name);
                }

                let caldata = response..C::response..C::["calendar-data"];
                try {
                    let calComp = getIcsService().parseICS(caldata, null);
                    for (let fbComp in cal.ical.calendarComponentIterator(calComp)) {
                        let interval;

                        let replyRangeStart = fbComp.startTime;
                        if (replyRangeStart && (aRangeStart.compare(replyRangeStart) == -1)) {
                            interval = new cal.FreeBusyInterval(aCalId,
                                                                calIFreeBusyInterval.UNKNOWN,
                                                                aRangeStart,
                                                                replyRangeStart);
                            periodsToReturn.push(interval);
                        }
                        let replyRangeEnd = fbComp.endTime;
                        if (replyRangeEnd && (aRangeEnd.compare(replyRangeEnd) == 1)) {
                            interval = new cal.FreeBusyInterval(aCalId,
                                                                calIFreeBusyInterval.UNKNOWN,
                                                                replyRangeEnd,
                                                                aRangeEnd);
                            periodsToReturn.push(interval);
                        }

                        for (let fbProp in cal.ical.propertyIterator(fbComp, "FREEBUSY")) {
                            let fbType = fbProp.getParameter("FBTYPE");
                            if (fbType) {
                                fbType = fbTypeMap[fbType];
                            } else {
                                fbType = calIFreeBusyInterval.UNKNOWN;
                            }
                            let parts = fbProp.value.split("/");
                            let begin = cal.createDateTime(parts[0]);
                            let end;
                            if (parts[1].charAt(0) == "P") { // this is a duration
                                end = begin.clone();
                                end.addDuration(cal.createDuration(parts[1]));
                            } else {
                                // This is a date string
                                end = cal.createDateTime(parts[1]);
                            }
                            interval = new cal.FreeBusyInterval(aCalId,
                                                                fbType,
                                                                begin,
                                                                end);
                            periodsToReturn.push(interval);
                        }
                    }
                } catch (exc) {
                    cal.ERROR("CalDAV: Error parsing free-busy info.");
                }

                aListener.onResult(null, periodsToReturn);
            } else {
                cal.LOG("CalDAV: Received status " + request.responseStatus +
                        " from freebusy query for " + thisCalendar.name);
                aListener.onResult(null, null);
            }
        };

        cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
    },

    ensurePath: function caldav_ensurePath(aString) {
        if (aString.charAt(0) != "/") {
            let bogusUri = makeURL(aString);
            return bogusUri.path;
        }
        return aString;
    },

    isInbox: function caldav_isInbox(aString) {
        return ((this.hasScheduling || this.hasAutoScheduling) && this.mInboxUrl &&
                aString.indexOf(this.mInboxUrl.spec) == 0);
    },

    /**
     * Query contents of scheduling inbox
     *
     */
    pollInbox: function caldav_pollInbox() {
        // If polling the inbox was switched off, no need to poll the inbox.
        // Also, if we have more than one calendar in this CalDAV account, we
        // want only one of them to be checking the inbox.
        if ((!this.hasScheduling && !this.hasAutoScheduling) || !this.mShouldPollInbox || !this.firstInRealm()) {
            return;
        }

        this.getUpdatedItems(this.mInboxUrl, null);
    },

    //
    // take calISchedulingSupport interface base implementation (cal.ProviderBase)
    //

    processItipReply: function caldav_processItipReply(aItem, aPath) {
        // modify partstat for in-calendar item
        // delete item from inbox
        let thisCalendar = this;

        let getItemListener = {};
        getItemListener.onOperationComplete = function caldav_gUIs_oOC(aCalendar,
                                                                       aStatus,
                                                                       aOperationType,
                                                                       aId,
                                                                       aDetail) {
        };
        getItemListener.onGetResult = function caldav_pIR_oGR(aCalendar,
                                                              aStatus,
                                                              aItemType,
                                                              aDetail,
                                                              aCount,
                                                              aItems) {
            let itemToUpdate = aItems[0];
            if (aItem.recurrenceId && itemToUpdate.recurrenceInfo) {
                itemToUpdate = itemToUpdate.recurrenceInfo.getOccurrenceFor(aItem.recurrenceId);
            }
            let newItem = itemToUpdate.clone();

            for each (let attendee in aItem.getAttendees({})) {
                let att = newItem.getAttendeeById(attendee.id);
                if (att) {
                    newItem.removeAttendee(att);
                    att = att.clone();
                    att.participationStatus = attendee.participationStatus;
                    newItem.addAttendee(att);
                }
            }
            thisCalendar.doModifyItemOrUseCache(newItem, itemToUpdate.parentItem /* related to bug 396182 */,
                                      true, modListener, true);
        };

        let modListener = {};
        modListener.onOperationComplete = function caldav_pIR_moOC(aCalendar,
                                                                   aStatus,
                                                                   aOperationType,
                                                                   aItemId,
                                                                   aDetail) {
            cal.LOG("CalDAV: status " + aStatus + " while processing iTIP REPLY " +
                    " for " + thisCalendar.name);
            // don't delete the REPLY item from inbox unless modifying the master
            // item was successful
            if (aStatus == 0) { // aStatus undocumented; 0 seems to indicate no error
                let delUri = thisCalendar.calendarUri.clone();
                delUri.path = aPath;
                thisCalendar.doDeleteItemOrUseCache(aItem, true, null, true, true, delUri);
            }
        };

        this.mOfflineStorage.getItem(aItem.id, getItemListener);
    },

    canNotify: function caldav_canNotify(aMethod, aItem) {
        if (this.hasAutoScheduling) {
            // canNotify should return false if the schedule agent is client
            // so the itip transport(imip) takes care of notifying participants
            if (aItem.organizer &&
                aItem.organizer.getProperty("SCHEDULE-AGENT") == "CLIENT") {
                return false;
            }
            return true;
        }
        return false; // use outbound iTIP for all
    },

    //
    // calIItipTransport interface
    //

    get scheme() {
        return "mailto";
    },

    mSenderAddress: null,
    get senderAddress() {
        return this.mSenderAddress || this.calendarUserAddress;
    },
    set senderAddress(aString) {
        return (this.mSenderAddress = aString);
    },

    sendItems: function caldav_sendItems(aCount, aRecipients, aItipItem) {

        if (this.hasAutoScheduling) {
            // If auto scheduling is supported by the server we still need
            // to send out REPLIES for meetings where the ORGANIZER has the
            // parameter SCHEDULE-AGENT set to CLIENT, this property is
            // checked in in canNotify()
            if (aItipItem.responseMethod == "REPLY") {
                let imipTransport = cal.getImipTransport(this);
                if (imipTransport) {
                    imipTransport.sendItems(aCount, aRecipients, aItipItem);
                }
            }
            // Servers supporting auto schedule should handle all other
            // scheduling operations for now. Note that eventually the client
            // could support setting a SCHEDULE-AGENT=CLIENT parameter on
            // ATTENDEES and/or interpreting the SCHEDULE-STATUS parameter which
            // could translate in the client sending out IMIP REQUESTS
            // for specific attendees.
            return;
        }

        if (aItipItem.responseMethod == "REPLY") {
            // Get my participation status
            let attendee = aItipItem.getItemList({})[0].getAttendeeById(this.calendarUserAddress);
            if (!attendee) {
                return;
            }
            // work around BUG 351589, the below just removes RSVP:
            aItipItem.setAttendeeStatus(attendee.id, attendee.participationStatus);
        }

        for each (let item in aItipItem.getItemList({})) {

            let serializer = Components.classes["@mozilla.org/calendar/ics-serializer;1"]
                                       .createInstance(Components.interfaces.calIIcsSerializer);
            serializer.addItems([item], 1);
            let methodProp = getIcsService().createIcalProperty("METHOD");
            methodProp.value = aItipItem.responseMethod;
            serializer.addProperty(methodProp);
            let uploadData = serializer.serializeToString();
            let requestUri = this.makeUri(null, this.outboxUrl);

            let httpchannel = cal.prepHttpChannel(requestUri,
                                                  uploadData,
                                                  "text/calendar; charset=utf-8",
                                                  this);
            httpchannel.requestMethod = "POST";
            httpchannel.setRequestHeader("Originator", this.calendarUserAddress, false);
            for each (let recipient in aRecipients) {
                httpchannel.setRequestHeader("Recipient", recipient.id, true);
            }

            let thisCalendar = this;
            let streamListener = {
                onStreamComplete: function caldav_sendItems_oSC(aLoader, aContext, aStatus,
                                                                aResultLength, aResult) {
                    let request = aLoader.request.QueryInterface(Components.interfaces.nsIHttpChannel);
                    let status;
                    try {
                        status = request.responseStatus;
                    } catch (ex) {
                        status = Components.interfaces.calIErrors.DAV_POST_ERROR;
                        cal.LOG("CalDAV: no response status when sending iTIP for" +
                                thisCalendar.name);
                    }

                    if (status != 200) {
                        cal.LOG("CalDAV: Sending iTIP failed with status " + status +
                                " for " + thisCalendar.name);
                    }

                    let str = cal.convertByteArray(aResult, aResultLength, "UTF-8", false);
                    if (str) {
                        if (thisCalendar.verboseLogging()) {
                            cal.LOG("CalDAV: recv: " + str);
                        }
                    } else {
                        cal.LOG("CalDAV: Failed to parse iTIP response for" +
                                thisCalendar.name);
                    }

                    let C = new Namespace("C", "urn:ietf:params:xml:ns:caldav");
                    let D = new Namespace("D", "DAV:");
                    let responseXML = cal.safeNewXML(str);

                    let remainingAttendees = [];
                    for each (let response in responseXML.*::response) {
                        let recip = response..C::recipient..D::href;
                        let status = response..C::["request-status"];
                        if (status.substr(0, 1) != "2") {
                            if (thisCalendar.verboseLogging()) {
                                cal.LOG("CalDAV: failed delivery to " + recip);
                            }
                            for each (let att in aRecipients) {
                                if (att.id.toLowerCase() == recip.toLowerCase()) {
                                    remainingAttendees.push(att);
                                    break;
                                }
                            }
                        }
                    }

                    if (remainingAttendees.length) {
                        // try to fall back to email delivery if CalDAV-sched
                        // didn't work
                        let imipTransport = cal.getImipTransport(thisCalendar);
                        if (imipTransport) {
                            if (thisCalendar.verboseLogging()) {
                                cal.LOG("CalDAV: sending email to " + remainingAttendees.length + " recipients");
                            }
                            imipTransport.sendItems(remainingAttendees.length, remainingAttendees, aItipItem);
                        } else {
                            cal.LOG("CalDAV: no fallback to iTIP/iMIP transport for " +
                                    thisCalendar.name);
                        }
                    }
                }
            };

            if (this.verboseLogging()) {
                cal.LOG("CalDAV: send(" + requestUri.spec + "): " + uploadData);
            }
            cal.sendHttpRequest(cal.createStreamLoader(), httpchannel, streamListener);
        }
    },

    mVerboseLogging: undefined,
    verboseLogging: function caldav_verboseLogging() {
        if (this.mVerboseLogging === undefined) {
            this.mVerboseLogging = getPrefSafe("calendar.debug.log.verbose", false);
        }
        return this.mVerboseLogging;
    },

    getSerializedItem: function caldav_getSerializedItem(aItem) {
        let serializer = Components.classes["@mozilla.org/calendar/ics-serializer;1"]
                                   .createInstance(Components.interfaces.calIIcsSerializer);
        serializer.addItems([aItem], 1);
        let serializedItem = serializer.serializeToString();
        if (this.verboseLogging()) {
            cal.LOG("CalDAV: send: " + serializedItem);
        }
        return serializedItem;
    },

    // nsIChannelEventSink implementation
    onChannelRedirect: function caldav_onChannelRedirect(aOldChannel, aNewChannel, aFlags) {

        let uploadData;
        let uploadContent;
        if (aOldChannel instanceof Components.interfaces.nsIUploadChannel &&
            aOldChannel instanceof Components.interfaces.nsIHttpChannel &&
            aOldChannel.uploadStream) {
            uploadData = aOldChannel.uploadStream;
            uploadContent = aOldChannel.getRequestHeader("Content-Type");
        }

        cal.prepHttpChannel(null,
                            uploadData,
                            uploadContent,
                            this,
                            aNewChannel);

        // Make sure we can get/set headers on both channels.
        aNewChannel.QueryInterface(Components.interfaces.nsIHttpChannel);
        aOldChannel.QueryInterface(Components.interfaces.nsIHttpChannel);


        function copyHeader(aHdr) {
            try {
                let hdrValue = aOldChannel.getRequestHeader(aHdr);
                if (hdrValue) {
                    aNewChannel.setRequestHeader(aHdr, hdrValue, false);
                }
            } catch(e) {
                if (e.code != Components.results.NS_ERROR_NOT_AVAILIBLE) {
                    // The header could possibly not be availible, ignore that
                    // case but throw otherwise
                    throw e;
               }
            }
        }

        // If any other header is used, it should be added here. We might want
        // to just copy all headers over to the new channel.
        copyHeader("Depth");
        copyHeader("Originator");
        copyHeader("Recipient");
        copyHeader("If-None-Match");
        copyHeader("If-Match");

        aNewChannel.requestMethod = aOldChannel.requestMethod;
    },

    isInvitation: function caldav_isInvitation(aItem) {
        // Inverse inc. ACL addition
        if (!this.mACLEntry || !this.mACLEntry.hasAccessControl) {
            // No ACL support - fallback to the old mehtod
            let id = this.getProperty("organizerId");
            if (id) {
                let org = aItem.organizer;
                if (!org || (org.id.toLowerCase() == id.toLowerCase())) {
                    return false;
                }
                return (aItem.getAttendeeById(id) != null);
            }
            return false;
        }

        let org = aItem.organizer;
        if (!org) {
            // HACK
            // if we don't have an organizer, this is perhaps because it's an exception
            // to a recurring event. We check the parent item.
            if (aItem.parentItem) {
                org = aItem.parentItem.organizer;
                if (!org) return false;
            }
            else
                return false;
        }

        // We check if :
        // - the organizer of the event is NOT within the owner's identities of this calendar
        // - if the one of the owner's identities of this calendar is in the attendees
        let ownerIdentities = {};
        this.mACLEntry.getOwnerIdentities({}, ownerIdentities);
        ownerIdentities = ownerIdentities.value;
        for (let i = 0; i < ownerIdentities.length; i++) {
            let identity = "mailto:" + ownerIdentities[i].email.toLowerCase();
            if (org.id.toLowerCase() == identity)
                return false;

            if (aItem.getAttendeeById(identity) != null)
                return true;
        }

        return false;
    },

    getInvitedAttendee: function caldav_getInvitedAttendee(aItem) {
      let id = this.getProperty("organizerId");
      let attendee = (id ? aItem.getAttendeeById(id) : null);

      if (!attendee && this.mACLEntry) {
          let ownerIdentities = {};
          this.mACLEntry.getOwnerIdentities({}, ownerIdentities);
          ownerIdentities = ownerIdentities.value;
          if (ownerIdentities.length > 0) {
              let identity;
              for (let i = 0; !attendee && i < ownerIdentities.length; i++) {
                  identity = "mailto:" + ownerIdentities[i].email.toLowerCase();
                  attendee = aItem.getAttendeeById(identity);
              }
          }
      }

      return attendee;
    },

    reenable: function caldav_reenable(aChangeLogListener) {
        // we reset our calendar status
        this.setProperty("currentStatus", Components.results.NS_OK);
        this.readOnly = false;
        this.disabled = false;
        // check if maybe our calendar has become available
        this.checkDavResourceType(aChangeLogListener);

      // try to reread the ACLs
        let aclMgr = Components.classes["@inverse.ca/calendar/caldav-acl-manager;1"]
                               .getService(Components.interfaces.calICalDAVACLManager);
        aclMgr.refresh(this.uri.spec);
        this.mACLEntry = null;
    }
};


function calDavObserver(aCalendar) {
    this.mCalendar = aCalendar;
}

calDavObserver.prototype = {
    mCalendar: null,
    mInBatch: false,

    // calIObserver:
    onStartBatch: function() {
        this.mCalendar.observers.notify("onStartBatch");
        this.mInBatch = true;
    },
    onEndBatch: function() {
        this.mCalendar.observers.notify("onEndBatch");
        this.mInBatch = false;
    },
    onLoad: function(calendar) {
        this.mCalendar.observers.notify("onLoad", [calendar]);
    },
    onAddItem: function(aItem) {
        this.mCalendar.observers.notify("onAddItem", [aItem]);
    },
    onModifyItem: function(aNewItem, aOldItem) {
        this.mCalendar.observers.notify("onModifyItem", [aNewItem, aOldItem]);
    },
    onDeleteItem: function(aDeletedItem) {
        this.mCalendar.observers.notify("onDeleteItem", [aDeletedItem]);
    },
    onPropertyChanged: function(aCalendar, aName, aValue, aOldValue) {
        this.mCalendar.observers.notify("onPropertyChanged", [aCalendar, aName, aValue, aOldValue]);
    },
    onPropertyDeleting: function(aCalendar, aName) {
        this.mCalendar.observers.notify("onPropertyDeleting", [aCalendar, aName]);
    },

    onError: function(aCalendar, aErrNo, aMessage) {
        this.mCalendar.readOnly = true;
        this.mCalendar.notifyError(aErrNo, aMessage);
    }
};
