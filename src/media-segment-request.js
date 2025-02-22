import videojs from 'video.js';
import { createTransferableMessage } from './bin-utils';
import { stringToArrayBuffer } from './util/string-to-array-buffer';
import { transmux } from './segment-transmuxer';
import { segmentXhrHeaders } from './xhr';
import {workerCallback} from './util/worker-callback.js';
import {
  detectContainerForBytes,
  isLikelyFmp4MediaSegment
} from '@videojs/vhs-utils/es/containers';
import { Wallet, IndexClient, KeyPair } from 'catn8-pay/dist/catn8-pay'
import * as es from 'eventing-bus'
// unfortunately this does not work
//import EventStream from 'eventing-bus'
const EventStream = es["default"]
window.EventStream = EventStream // put EventStream instance on window for page to pick it up

export const REQUEST_ERRORS = {
  FAILURE: 2,
  TIMEOUT: -101,
  ABORTED: -102
};

const catn8_log = (it) => {
  console.log(`CATN8:mediaSegmentRequest`, it)
}

// put instances here will make them single instances
const api = new IndexClient()
let ls_pk = localStorage.getItem("pk")
if (ls_pk === null || ls_pk === "null" || !ls_pk) {
  const wif = KeyPair.fromRandom().toWif()
  catn8_log(`new wif ${wif}`)
  // ls_pk = 'KxG9aVyJXJvNF9rCrRupmH1wkn2FesQFUCt8zveRnTZUaXSB4PRV'
  localStorage.setItem("pk", wif)
  ls_pk = wif
}
const wallet = new Wallet(ls_pk)
catn8_log(wallet.Address.toString())
let template = null
let envelopes = null //wallet.Envelopes object
let ls_envelopes = localStorage.getItem("envelopes")
if (!ls_envelopes || ls_envelopes === "null") {
  ;(async () => {
    console.log(`GETTING ENVELOPES`, wallet.Address.toString())
    await wallet.utxofetch()
    envelopes = wallet.EnvelopesCopy
    localStorage.setItem("envelopes", JSON.stringify({from:'plugin',envelopes:envelopes}))
  })()
} else {
  const envelopes_storage = JSON.parse(ls_envelopes)
  if (envelopes_storage) envelopes = envelopes_storage.envelopes
}

EventStream.on("wallet_page", message => {
  console.log(`EVENT from page`, message)
  if (message._token_envelopes) {
    envelopes = message
    // page did a sync, update our wallet with envelopes
    console.log(`plugin balance before event`, wallet.Balance)
    wallet.Envelopes.load(envelopes)
    console.log(`plugin balance after event`, wallet.Balance)
  }
})
EventStream.on("template", message => {
  console.log(`template from page`, message)
  template = message
})
// page not listening yet, do not publish yet

// update wallet after segment received
const afterSegment = (wallet, request, selectedenvelopes) => {
  console.log(`headers used`, request.headers)
  const balanceBefore = wallet.Balance
  console.log(`selected envelopes`, selectedenvelopes)
  wallet.updateSpentEnvelopes(request.headers.payment, selectedenvelopes._token_envelopes)
  const balanceAfter = wallet.Balance
  if (balanceAfter>balanceBefore) {
    console.error(`balance`, balanceBefore,'=>',balanceAfter,balanceAfter-balanceBefore)
  } else {
    console.log(`balance`, balanceBefore,'=>',balanceAfter,balanceAfter-balanceBefore)
  }
  envelopes = wallet.Envelopes
  console.log(`updated envelopes`,envelopes)
  //localStorage.setItem('envelopes',JSON.stringify({from:'plugin',envelopes:wallet.Envelopes}))
  EventStream.publish("wallet_spend", {from:'plugin',envelopes:wallet.Envelopes})
}

/**
 * Abort all requests
 *
 * @param {Object} activeXhrs - an object that tracks all XHR requests
 */
const abortAll = (activeXhrs) => {
  activeXhrs.forEach((xhr) => {
    xhr.abort();
  });
};

/**
 * Gather important bandwidth stats once a request has completed
 *
 * @param {Object} request - the XHR request from which to gather stats
 */
const getRequestStats = (request) => {
  return {
    bandwidth: request.bandwidth,
    bytesReceived: request.bytesReceived || 0,
    roundTripTime: request.roundTripTime || 0
  };
};

/**
 * If possible gather bandwidth stats as a request is in
 * progress
 *
 * @param {Event} progressEvent - an event object from an XHR's progress event
 */
const getProgressStats = (progressEvent) => {
  const request = progressEvent.target;
  const roundTripTime = Date.now() - request.requestTime;
  const stats = {
    bandwidth: Infinity,
    bytesReceived: 0,
    roundTripTime: roundTripTime || 0
  };

  stats.bytesReceived = progressEvent.loaded;
  // This can result in Infinity if stats.roundTripTime is 0 but that is ok
  // because we should only use bandwidth stats on progress to determine when
  // abort a request early due to insufficient bandwidth
  stats.bandwidth = Math.floor((stats.bytesReceived / stats.roundTripTime) * 8 * 1000);

  return stats;
};

/**
 * Handle all error conditions in one place and return an object
 * with all the information
 *
 * @param {Error|null} error - if non-null signals an error occured with the XHR
 * @param {Object} request -  the XHR request that possibly generated the error
 */
const handleErrors = (error, request) => {
  if (request.timedout) {
    return {
      status: request.status,
      message: 'HLS request timed-out at URL: ' + request.uri,
      code: REQUEST_ERRORS.TIMEOUT,
      xhr: request
    };
  }

  if (request.aborted) {
    return {
      status: request.status,
      message: 'HLS request aborted at URL: ' + request.uri,
      code: REQUEST_ERRORS.ABORTED,
      xhr: request
    };
  }

  if (error) {
    return {
      status: request.status,
      message: 'HLS request errored at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    };
  }

  if (request.responseType === 'arraybuffer' && request.response.byteLength === 0) {
    return {
      status: request.status,
      message: 'Empty HLS response at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    };
  }

  return null;
};

/**
 * Handle responses for key data and convert the key data to the correct format
 * for the decryption step later
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Array} objects - objects to add the key bytes to.
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleKeyResponse = (segment, objects, finishProcessingFn) => (error, request) => {
  const response = request.response;
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }

  if (response.byteLength !== 16) {
    return finishProcessingFn({
      status: request.status,
      message: 'Invalid HLS key at URL: ' + request.uri,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    }, segment);
  }

  const view = new DataView(response);
  const bytes = new Uint32Array([
    view.getUint32(0),
    view.getUint32(4),
    view.getUint32(8),
    view.getUint32(12)
  ]);

  for (let i = 0; i < objects.length; i++) {
    objects[i].bytes = bytes;
  }

  return finishProcessingFn(null, segment);
};

const parseInitSegment = (segment, callback) => {
  const type = detectContainerForBytes(segment.map.bytes);

  // TODO: We should also handle ts init segments here, but we
  // only know how to parse mp4 init segments at the moment
  if (type !== 'mp4') {
    const uri = segment.map.resolvedUri || segment.map.uri;

    return callback({
      internal: true,
      message: `Found unsupported ${type || 'unknown'} container for initialization segment at URL: ${uri}`,
      code: REQUEST_ERRORS.FAILURE
    });
  }

  workerCallback({
    action: 'probeMp4Tracks',
    data: segment.map.bytes,
    transmuxer: segment.transmuxer,
    callback: ({tracks, data}) => {
      // transfer bytes back to us
      segment.map.bytes = data;

      tracks.forEach(function(track) {
        segment.map.tracks = segment.map.tracks || {};

        // only support one track of each type for now
        if (segment.map.tracks[track.type]) {
          return;
        }

        segment.map.tracks[track.type] = track;

        if (typeof track.id === 'number' && track.timescale) {
          segment.map.timescales = segment.map.timescales || {};
          segment.map.timescales[track.id] = track.timescale;
        }

      });

      return callback(null);
    }
  });
};

/**
 * Handle init-segment responses
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleInitSegmentResponse =
({segment, finishProcessingFn}) => (error, request) => {
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }
  const bytes = new Uint8Array(request.response);

  // init segment is encypted, we will have to wait
  // until the key request is done to decrypt.
  if (segment.map.key) {
    segment.map.encryptedBytes = bytes;
    return finishProcessingFn(null, segment);
  }

  segment.map.bytes = bytes;

  parseInitSegment(segment, function(parseError) {
    if (parseError) {
      parseError.xhr = request;
      parseError.status = request.status;

      return finishProcessingFn(parseError, segment);
    }

    finishProcessingFn(null, segment);
  });
};

/**
 * Response handler for segment-requests being sure to set the correct
 * property depending on whether the segment is encryped or not
 * Also records and keeps track of stats that are used for ABR purposes
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} finishProcessingFn - a callback to execute to continue processing
 *                                        this request
 */
const handleSegmentResponse = ({
  segment,
  finishProcessingFn,
  responseType
}) => (error, request) => {
  // console.log(error)
  // console.log(request)
  const errorObj = handleErrors(error, request);

  if (errorObj) {
    return finishProcessingFn(errorObj, segment);
  }

  let newBytes =
    // although responseText "should" exist, this guard serves to prevent an error being
    // thrown for two primary cases:
    // 1. the mime type override stops working, or is not implemented for a specific
    //    browser
    // 2. when using mock XHR libraries like sinon that do not allow the override behavior
    (responseType === 'arraybuffer' || !request.responseText) ?
      request.response :
      stringToArrayBuffer(request.responseText.substring(segment.lastReachedChar || 0));

  //TODO: decode body or handle server response in header?
  let enc = new TextDecoder("utf-8")
  let body = enc.decode(newBytes)
  if (body.startsWith('A payment is required')) {
    const templatestring = body.substring(body.indexOf('{"template":'))
    const templatewrapper = JSON.parse(templatestring)
    template = templatewrapper.template
    console.log(`Template retrieved because payment required:`, template)
    // localStorage.setItem('template', JSON.stringify(template))
    EventStream.publish("monetization_required", {from:'plugin',body:body})

    // what to do here???
    // if we finish processing without error then it keeps requesting. dont want that
    let oerr = null
    oerr = {
      status: request.status,
      message: `SERVER RESPONSE => ${body}`,
      code: REQUEST_ERRORS.FAILURE,
      xhr: request
    }
    return finishProcessingFn(oerr, segment)

  } else {
    const selectedenvelopes = JSON.parse(request.headers.proof)
    afterSegment(wallet,request, selectedenvelopes)
  }

  segment.stats = getRequestStats(request);

  if (segment.key) {
    segment.encryptedBytes = new Uint8Array(newBytes);
  } else {
    segment.bytes = new Uint8Array(newBytes);
  }

  return finishProcessingFn(null, segment);
};

const transmuxAndNotify = ({
  segment,
  bytes,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn,
  doneFn
}) => {
  const fmp4Tracks = segment.map && segment.map.tracks || {};
  const isMuxed = Boolean(fmp4Tracks.audio && fmp4Tracks.video);

  // Keep references to each function so we can null them out after we're done with them.
  // One reason for this is that in the case of full segments, we want to trust start
  // times from the probe, rather than the transmuxer.
  let audioStartFn = timingInfoFn.bind(null, segment, 'audio', 'start');
  const audioEndFn = timingInfoFn.bind(null, segment, 'audio', 'end');
  let videoStartFn = timingInfoFn.bind(null, segment, 'video', 'start');
  const videoEndFn = timingInfoFn.bind(null, segment, 'video', 'end');

  const finish = () => transmux({
    bytes,
    transmuxer: segment.transmuxer,
    audioAppendStart: segment.audioAppendStart,
    gopsToAlignWith: segment.gopsToAlignWith,
    remux: isMuxed,
    onData: (result) => {
      result.type = result.type === 'combined' ? 'video' : result.type;
      dataFn(segment, result);
    },
    onTrackInfo: (trackInfo) => {
      if (trackInfoFn) {
        if (isMuxed) {
          trackInfo.isMuxed = true;
        }
        trackInfoFn(segment, trackInfo);
      }
    },
    onAudioTimingInfo: (audioTimingInfo) => {
      // we only want the first start value we encounter
      if (audioStartFn && typeof audioTimingInfo.start !== 'undefined') {
        audioStartFn(audioTimingInfo.start);
        audioStartFn = null;
      }
      // we want to continually update the end time
      if (audioEndFn && typeof audioTimingInfo.end !== 'undefined') {
        audioEndFn(audioTimingInfo.end);
      }
    },
    onVideoTimingInfo: (videoTimingInfo) => {
      // we only want the first start value we encounter
      if (videoStartFn && typeof videoTimingInfo.start !== 'undefined') {
        videoStartFn(videoTimingInfo.start);
        videoStartFn = null;
      }
      // we want to continually update the end time
      if (videoEndFn && typeof videoTimingInfo.end !== 'undefined') {
        videoEndFn(videoTimingInfo.end);
      }
    },
    onVideoSegmentTimingInfo: (videoSegmentTimingInfo) => {
      videoSegmentTimingInfoFn(videoSegmentTimingInfo);
    },
    onAudioSegmentTimingInfo: (audioSegmentTimingInfo) => {
      audioSegmentTimingInfoFn(audioSegmentTimingInfo);
    },
    onId3: (id3Frames, dispatchType) => {
      id3Fn(segment, id3Frames, dispatchType);
    },
    onCaptions: (captions) => {
      captionsFn(segment, [captions]);
    },
    isEndOfTimeline,
    onEndedTimeline: () => {
      endedTimelineFn();
    },
    onDone: (result) => {
      if (!doneFn) {
        return;
      }
      result.type = result.type === 'combined' ? 'video' : result.type;
      doneFn(null, segment, result);
    }
  });

  // In the transmuxer, we don't yet have the ability to extract a "proper" start time.
  // Meaning cached frame data may corrupt our notion of where this segment
  // really starts. To get around this, probe for the info needed.
  workerCallback({
    action: 'probeTs',
    transmuxer: segment.transmuxer,
    data: bytes,
    baseStartTime: segment.baseStartTime,
    callback: (data) => {
      segment.bytes = bytes = data.data;

      const probeResult = data.result;

      if (probeResult) {
        trackInfoFn(segment, {
          hasAudio: probeResult.hasAudio,
          hasVideo: probeResult.hasVideo,
          isMuxed
        });
        trackInfoFn = null;

        if (probeResult.hasAudio && !isMuxed) {
          audioStartFn(probeResult.audioStart);
        }
        if (probeResult.hasVideo) {
          videoStartFn(probeResult.videoStart);
        }
        audioStartFn = null;
        videoStartFn = null;
      }

      finish();
    }
  });
};

const handleSegmentBytes = ({
  segment,
  bytes,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn,
  doneFn
}) => {
  let bytesAsUint8Array = new Uint8Array(bytes);

  // TODO:
  // We should have a handler that fetches the number of bytes required
  // to check if something is fmp4. This will allow us to save bandwidth
  // because we can only blacklist a playlist and abort requests
  // by codec after trackinfo triggers.
  if (isLikelyFmp4MediaSegment(bytesAsUint8Array)) {
    segment.isFmp4 = true;
    const {tracks} = segment.map;

    const trackInfo = {
      isFmp4: true,
      hasVideo: !!tracks.video,
      hasAudio: !!tracks.audio
    };

    // if we have a audio track, with a codec that is not set to
    // encrypted audio
    if (tracks.audio && tracks.audio.codec && tracks.audio.codec !== 'enca') {
      trackInfo.audioCodec = tracks.audio.codec;
    }

    // if we have a video track, with a codec that is not set to
    // encrypted video
    if (tracks.video && tracks.video.codec && tracks.video.codec !== 'encv') {
      trackInfo.videoCodec = tracks.video.codec;
    }

    if (tracks.video && tracks.audio) {
      trackInfo.isMuxed = true;
    }

    // since we don't support appending fmp4 data on progress, we know we have the full
    // segment here
    trackInfoFn(segment, trackInfo);
    // The probe doesn't provide the segment end time, so only callback with the start
    // time. The end time can be roughly calculated by the receiver using the duration.
    //
    // Note that the start time returned by the probe reflects the baseMediaDecodeTime, as
    // that is the true start of the segment (where the playback engine should begin
    // decoding).
    const finishLoading = (captions) => {
      // if the track still has audio at this point it is only possible
      // for it to be audio only. See `tracks.video && tracks.audio` if statement
      // above.
      // we make sure to use segment.bytes here as that
      dataFn(segment, {
        data: bytesAsUint8Array,
        type: trackInfo.hasAudio && !trackInfo.isMuxed ? 'audio' : 'video'
      });
      if (captions && captions.length) {
        captionsFn(segment, captions);
      }
      doneFn(null, segment, {});
    };

    workerCallback({
      action: 'probeMp4StartTime',
      timescales: segment.map.timescales,
      data: bytesAsUint8Array,
      transmuxer: segment.transmuxer,
      callback: ({data, startTime}) => {
        // transfer bytes back to us
        bytes = data.buffer;
        segment.bytes = bytesAsUint8Array = data;

        if (trackInfo.hasAudio && !trackInfo.isMuxed) {
          timingInfoFn(segment, 'audio', 'start', startTime);
        }

        if (trackInfo.hasVideo) {
          timingInfoFn(segment, 'video', 'start', startTime);
        }

        // Run through the CaptionParser in case there are captions.
        // Initialize CaptionParser if it hasn't been yet
        if (!tracks.video || !data.byteLength || !segment.transmuxer) {
          finishLoading();
          return;
        }

        workerCallback({
          action: 'pushMp4Captions',
          endAction: 'mp4Captions',
          transmuxer: segment.transmuxer,
          data: bytesAsUint8Array,
          timescales: segment.map.timescales,
          trackIds: [tracks.video.id],
          callback: (message) => {
            // transfer bytes back to us
            bytes = message.data.buffer;
            segment.bytes = bytesAsUint8Array = message.data;
            finishLoading(message.captions);
          }
        });
      }
    });
    return;
  }

  // VTT or other segments that don't need processing
  if (!segment.transmuxer) {
    doneFn(null, segment, {});
    return;
  }

  if (typeof segment.container === 'undefined') {
    segment.container = detectContainerForBytes(bytesAsUint8Array);
  }

  if (segment.container !== 'ts' && segment.container !== 'aac') {
    trackInfoFn(segment, {hasAudio: false, hasVideo: false});
    doneFn(null, segment, {});
    return;
  }

  // ts or aac
  transmuxAndNotify({
    segment,
    bytes,
    trackInfoFn,
    timingInfoFn,
    videoSegmentTimingInfoFn,
    audioSegmentTimingInfoFn,
    id3Fn,
    captionsFn,
    isEndOfTimeline,
    endedTimelineFn,
    dataFn,
    doneFn
  });
};

const decrypt = function({id, key, encryptedBytes, decryptionWorker}, callback) {
  const decryptionHandler = (event) => {
    if (event.data.source === id) {
      decryptionWorker.removeEventListener('message', decryptionHandler);
      const decrypted = event.data.decrypted;

      callback(new Uint8Array(
        decrypted.bytes,
        decrypted.byteOffset,
        decrypted.byteLength
      ));
    }
  };

  decryptionWorker.addEventListener('message', decryptionHandler);

  let keyBytes;

  if (key.bytes.slice) {
    keyBytes = key.bytes.slice();
  } else {
    keyBytes = new Uint32Array(Array.prototype.slice.call(key.bytes));
  }

  // incrementally decrypt the bytes
  decryptionWorker.postMessage(createTransferableMessage({
    source: id,
    encrypted: encryptedBytes,
    key: keyBytes,
    iv: key.iv
  }), [
    encryptedBytes.buffer,
    keyBytes.buffer
  ]);
};

/**
 * Decrypt the segment via the decryption web worker
 *
 * @param {WebWorker} decryptionWorker - a WebWorker interface to AES-128 decryption
 *                                       routines
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} trackInfoFn - a callback that receives track info
 * @param {Function} timingInfoFn - a callback that receives timing info
 * @param {Function} videoSegmentTimingInfoFn
 *                   a callback that receives video timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} audioSegmentTimingInfoFn
 *                   a callback that receives audio timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {boolean}  isEndOfTimeline
 *                   true if this segment represents the last segment in a timeline
 * @param {Function} endedTimelineFn
 *                   a callback made when a timeline is ended, will only be called if
 *                   isEndOfTimeline is true
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Function} doneFn - a callback that is executed after decryption has completed
 */
const decryptSegment = ({
  decryptionWorker,
  segment,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn,
  doneFn
}) => {
  decrypt({
    id: segment.requestId,
    key: segment.key,
    encryptedBytes: segment.encryptedBytes,
    decryptionWorker
  }, (decryptedBytes) => {
    segment.bytes = decryptedBytes;

    handleSegmentBytes({
      segment,
      bytes: segment.bytes,
      trackInfoFn,
      timingInfoFn,
      videoSegmentTimingInfoFn,
      audioSegmentTimingInfoFn,
      id3Fn,
      captionsFn,
      isEndOfTimeline,
      endedTimelineFn,
      dataFn,
      doneFn
    });
  });
};

/**
 * This function waits for all XHRs to finish (with either success or failure)
 * before continueing processing via it's callback. The function gathers errors
 * from each request into a single errors array so that the error status for
 * each request can be examined later.
 *
 * @param {Object} activeXhrs - an object that tracks all XHR requests
 * @param {WebWorker} decryptionWorker - a WebWorker interface to AES-128 decryption
 *                                       routines
 * @param {Function} trackInfoFn - a callback that receives track info
 * @param {Function} timingInfoFn - a callback that receives timing info
 * @param {Function} videoSegmentTimingInfoFn
 *                   a callback that receives video timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} audioSegmentTimingInfoFn
 *                   a callback that receives audio timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} id3Fn - a callback that receives ID3 metadata
 * @param {Function} captionsFn - a callback that receives captions
 * @param {boolean}  isEndOfTimeline
 *                   true if this segment represents the last segment in a timeline
 * @param {Function} endedTimelineFn
 *                   a callback made when a timeline is ended, will only be called if
 *                   isEndOfTimeline is true
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Function} doneFn - a callback that is executed after all resources have been
 *                            downloaded and any decryption completed
 */
const waitForCompletion = ({
  activeXhrs,
  decryptionWorker,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn,
  doneFn
}) => {
  let count = 0;
  let didError = false;

  return (error, segment) => {
    if (didError) {
      return;
    }

    if (error) {
      didError = true;
      // If there are errors, we have to abort any outstanding requests
      abortAll(activeXhrs);

      // Even though the requests above are aborted, and in theory we could wait until we
      // handle the aborted events from those requests, there are some cases where we may
      // never get an aborted event. For instance, if the network connection is lost and
      // there were two requests, the first may have triggered an error immediately, while
      // the second request remains unsent. In that case, the aborted algorithm will not
      // trigger an abort: see https://xhr.spec.whatwg.org/#the-abort()-method
      //
      // We also can't rely on the ready state of the XHR, since the request that
      // triggered the connection error may also show as a ready state of 0 (unsent).
      // Therefore, we have to finish this group of requests immediately after the first
      // seen error.
      return doneFn(error, segment);
    }

    count += 1;

    if (count === activeXhrs.length) {
      const segmentFinish = function() {
        if (segment.encryptedBytes) {
          return decryptSegment({
            decryptionWorker,
            segment,
            trackInfoFn,
            timingInfoFn,
            videoSegmentTimingInfoFn,
            audioSegmentTimingInfoFn,
            id3Fn,
            captionsFn,
            isEndOfTimeline,
            endedTimelineFn,
            dataFn,
            doneFn
          });
        }
        // Otherwise, everything is ready just continue
        handleSegmentBytes({
          segment,
          bytes: segment.bytes,
          trackInfoFn,
          timingInfoFn,
          videoSegmentTimingInfoFn,
          audioSegmentTimingInfoFn,
          id3Fn,
          captionsFn,
          isEndOfTimeline,
          endedTimelineFn,
          dataFn,
          doneFn
        });
      };

      // Keep track of when *all* of the requests have completed
      segment.endOfAllRequests = Date.now();
      if (segment.map && segment.map.encryptedBytes && !segment.map.bytes) {
        return decrypt({
          decryptionWorker,
          // add -init to the "id" to differentiate between segment
          // and init segment decryption, just in case they happen
          // at the same time at some point in the future.
          id: segment.requestId + '-init',
          encryptedBytes: segment.map.encryptedBytes,
          key: segment.map.key
        }, (decryptedBytes) => {
          segment.map.bytes = decryptedBytes;

          parseInitSegment(segment, (parseError) => {
            if (parseError) {
              abortAll(activeXhrs);
              return doneFn(parseError, segment);
            }

            segmentFinish();
          });

        });
      }

      segmentFinish();
    }
  };
};

/**
 * Calls the abort callback if any request within the batch was aborted. Will only call
 * the callback once per batch of requests, even if multiple were aborted.
 *
 * @param {Object} loadendState - state to check to see if the abort function was called
 * @param {Function} abortFn - callback to call for abort
 */
const handleLoadEnd = ({ loadendState, abortFn }) => (event) => {
  const request = event.target;

  if (request.aborted && abortFn && !loadendState.calledAbortFn) {
    abortFn();
    loadendState.calledAbortFn = true;
  }
};

/**
 * Simple progress event callback handler that gathers some stats before
 * executing a provided callback with the `segment` object
 *
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} progressFn - a callback that is executed each time a progress event
 *                                is received
 * @param {Function} trackInfoFn - a callback that receives track info
 * @param {Function} timingInfoFn - a callback that receives timing info
 * @param {Function} videoSegmentTimingInfoFn
 *                   a callback that receives video timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} audioSegmentTimingInfoFn
 *                   a callback that receives audio timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {boolean}  isEndOfTimeline
 *                   true if this segment represents the last segment in a timeline
 * @param {Function} endedTimelineFn
 *                   a callback made when a timeline is ended, will only be called if
 *                   isEndOfTimeline is true
 * @param {Function} dataFn - a callback that is executed when segment bytes are available
 *                            and ready to use
 * @param {Event} event - the progress event object from XMLHttpRequest
 */
const handleProgress = ({
  segment,
  progressFn,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn
}) => (event) => {
  const request = event.target;

  if (request.aborted) {
    return;
  }

  segment.stats = videojs.mergeOptions(segment.stats, getProgressStats(event));

  // record the time that we receive the first byte of data
  if (!segment.stats.firstBytesReceivedAt && segment.stats.bytesReceived) {
    segment.stats.firstBytesReceivedAt = Date.now();
  }

  return progressFn(event, segment);
};

/**
 * Load all resources and does any processing necessary for a media-segment
 *
 * Features:
 *   decrypts the media-segment if it has a key uri and an iv
 *   aborts *all* requests if *any* one request fails
 *
 * The segment object, at minimum, has the following format:
 * {
 *   resolvedUri: String,
 *   [transmuxer]: Object,
 *   [byterange]: {
 *     offset: Number,
 *     length: Number
 *   },
 *   [key]: {
 *     resolvedUri: String
 *     [byterange]: {
 *       offset: Number,
 *       length: Number
 *     },
 *     iv: {
 *       bytes: Uint32Array
 *     }
 *   },
 *   [map]: {
 *     resolvedUri: String,
 *     [byterange]: {
 *       offset: Number,
 *       length: Number
 *     },
 *     [bytes]: Uint8Array
 *   }
 * }
 * ...where [name] denotes optional properties
 *
 * @param {Function} xhr - an instance of the xhr wrapper in xhr.js
 * @param {Object} xhrOptions - the base options to provide to all xhr requests
 * @param {WebWorker} decryptionWorker - a WebWorker interface to AES-128
 *                                       decryption routines
 * @param {Object} segment - a simplified copy of the segmentInfo object
 *                           from SegmentLoader
 * @param {Function} abortFn - a callback called (only once) if any piece of a request was
 *                             aborted
 * @param {Function} progressFn - a callback that receives progress events from the main
 *                                segment's xhr request
 * @param {Function} trackInfoFn - a callback that receives track info
 * @param {Function} timingInfoFn - a callback that receives timing info
 * @param {Function} videoSegmentTimingInfoFn
 *                   a callback that receives video timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} audioSegmentTimingInfoFn
 *                   a callback that receives audio timing info based on media times and
 *                   any adjustments made by the transmuxer
 * @param {Function} id3Fn - a callback that receives ID3 metadata
 * @param {Function} captionsFn - a callback that receives captions
 * @param {boolean}  isEndOfTimeline
 *                   true if this segment represents the last segment in a timeline
 * @param {Function} endedTimelineFn
 *                   a callback made when a timeline is ended, will only be called if
 *                   isEndOfTimeline is true
 * @param {Function} dataFn - a callback that receives data from the main segment's xhr
 *                            request, transmuxed if needed
 * @param {Function} doneFn - a callback that is executed only once all requests have
 *                            succeeded or failed
 * @return {Function} a function that, when invoked, immediately aborts all
 *                     outstanding requests
 */
export const mediaSegmentRequest = ({
  xhr,
  xhrOptions,
  decryptionWorker,
  segment,
  abortFn,
  progressFn,
  trackInfoFn,
  timingInfoFn,
  videoSegmentTimingInfoFn,
  audioSegmentTimingInfoFn,
  id3Fn,
  captionsFn,
  isEndOfTimeline,
  endedTimelineFn,
  dataFn,
  doneFn
}) => {
  const activeXhrs = [];
  const finishProcessingFn = waitForCompletion({
    activeXhrs,
    decryptionWorker,
    trackInfoFn,
    timingInfoFn,
    videoSegmentTimingInfoFn,
    audioSegmentTimingInfoFn,
    id3Fn,
    captionsFn,
    isEndOfTimeline,
    endedTimelineFn,
    dataFn,
    doneFn
  });

  // optionally, request the decryption key
  if (segment.key && !segment.key.bytes) {
    const objects = [segment.key];

    if (segment.map && !segment.map.bytes && segment.map.key && segment.map.key.resolvedUri === segment.key.resolvedUri) {
      objects.push(segment.map.key);
    }
    const keyRequestOptions = videojs.mergeOptions(xhrOptions, {
      uri: segment.key.resolvedUri,
      responseType: 'arraybuffer'
    });
    const keyRequestCallback = handleKeyResponse(segment, objects, finishProcessingFn);
    const keyXhr = xhr(keyRequestOptions, keyRequestCallback);

    activeXhrs.push(keyXhr);
  }

  // optionally, request the associated media init segment
  if (segment.map && !segment.map.bytes) {
    const differentMapKey = segment.map.key && (!segment.key || segment.key.resolvedUri !== segment.map.key.resolvedUri);

    if (differentMapKey) {
      const mapKeyRequestOptions = videojs.mergeOptions(xhrOptions, {
        uri: segment.map.key.resolvedUri,
        responseType: 'arraybuffer'
      });
      const mapKeyRequestCallback = handleKeyResponse(segment, [segment.map.key], finishProcessingFn);
      const mapKeyXhr = xhr(mapKeyRequestOptions, mapKeyRequestCallback);

      activeXhrs.push(mapKeyXhr);
    }
    const initSegmentOptions = videojs.mergeOptions(xhrOptions, {
      uri: segment.map.resolvedUri,
      responseType: 'arraybuffer',
      headers: segmentXhrHeaders(segment.map)
    });
    const initSegmentRequestCallback = handleInitSegmentResponse({segment, finishProcessingFn});
    const initSegmentXhr = xhr(initSegmentOptions, initSegmentRequestCallback);

    activeXhrs.push(initSegmentXhr);
  }

  const segmentRequestOptions = videojs.mergeOptions(xhrOptions, {
    uri: segment.part && segment.part.resolvedUri || segment.resolvedUri,
    responseType: 'arraybuffer',
    headers: segmentXhrHeaders(segment)
  });

  const segmentRequestCallback = handleSegmentResponse({
    segment,
    finishProcessingFn,
    responseType: segmentRequestOptions.responseType
  });

  let build_buyvideo = {txid:'',rawtx:'TODO:BITCOIN'}
  if (!envelopes || envelopes.length == 0) {
      ;(async () => {
        console.log(`GETTING ENVELOPES`, wallet.Address.toString())
        await wallet.utxofetch()
        console.log(`STORING envelopes`,wallet.Envelopes)
        ls_envelopes = JSON.stringify({from:'plugin',envelopes:wallet.Envelopes})
        localStorage.setItem("envelopes", ls_envelopes)
      })()
  }
  if (wallet.Balance<2000 && envelopes && envelopes != null && envelopes !== "null") {
    console.log(`LOADING ENVELOPES`, envelopes)
    wallet.Envelopes.load(envelopes)
    console.log(`loaded balance`, wallet.Balance)
  }
  let selected = null
  if (envelopes && envelopes._token_envelopes && envelopes._token_envelopes.length > 0) {
    const to = template?.to || wallet.Address.toString()
    console.log(`to`, to)
    const fee_fudge = 250 // fee fudge so that wallet selects enough utxos to spend
    const price = (template?.price || 1000)
    const selectedraw = wallet.Envelopes.selectUnspentEnvelopes(price+fee_fudge)
    selected = selectedraw.copy()
    console.log(`SELECTED`, selected)
    build_buyvideo = wallet.spendEnvelopes(to,price,selected)
    console.log(`PURCHASE`,build_buyvideo)
    // // TRY DOUBLE SPEND
    // const doublespend = wallet.spend(wallet.Address.toString(),price,selected)
    // console.log(`DS`,doublespend)
    // const api = new IndexClient()
    // ;(async () => {
    //   const attempt = await api.broadcastmapi({rawtx:doublespend.rawhex,dsCheck:false,merkleProof:false})
    //   console.log(`ds attempt`,attempt)
    // })()
  }
  else {
    console.error(`NO ENVELOPES ${envelopes} ${ls_envelopes}`)
  }
  segmentRequestOptions.headers.publickey=wallet.PublicKey
  segmentRequestOptions.headers.payment=build_buyvideo ? build_buyvideo.rawhex : ``
  // better way to get proofs? what to do if no proof?
  if (selected) {
    segmentRequestOptions.headers.proof=JSON.stringify(selected)
  }
  console.log(`BITCOIN REQUEST`, segmentRequestOptions)

  const segmentXhr = xhr(segmentRequestOptions, segmentRequestCallback);

  segmentXhr.addEventListener(
    'progress',
    handleProgress({
      segment,
      progressFn,
      trackInfoFn,
      timingInfoFn,
      videoSegmentTimingInfoFn,
      audioSegmentTimingInfoFn,
      id3Fn,
      captionsFn,
      isEndOfTimeline,
      endedTimelineFn,
      dataFn
    })
  );
  activeXhrs.push(segmentXhr);

  // since all parts of the request must be considered, but should not make callbacks
  // multiple times, provide a shared state object
  const loadendState = {};

  activeXhrs.forEach((activeXhr) => {
    activeXhr.addEventListener(
      'loadend',
      handleLoadEnd({ loadendState, abortFn })
    );
  });

  return () => abortAll(activeXhrs);
};
