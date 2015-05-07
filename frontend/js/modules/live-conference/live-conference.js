'use strict';

angular.module('op.live-conference', [
  'op.liveconference-templates',
  'op.easyrtc',
  'op.websocket',
  'op.notification',
  'meetings.authentication',
  'meetings.session',
  'meetings.conference',
  'meetings.invitation',
  'meetings.report',
  'meetings.wizard'
])
.constant('MAX_RECONNECT_TIMEOUT', 30000)
.controller('conferenceController', [
  '$scope',
  '$log',
  'session',
  'conference',
  'ioConnectionManager',
  function($scope, $log, session, conference, ioConnectionManager) {
    session.ready.then(function() {
      var wsServerURI = '';

      if (conference.configuration && conference.configuration.hosts && conference.configuration.hosts.length) {
        conference.configuration.hosts.forEach(function(host) {
          if ('ws' === host.type) {
            wsServerURI = host.url;
          }
        });
      }

      $scope.wsServerURI = wsServerURI;
      $log.info('Using \'%s\' as the websocket backend.', wsServerURI);

      $log.debug('Connecting to websocket at address \'%s\' for user %s.', $scope.wsServerURI, session.user);
      ioConnectionManager.connect($scope.wsServerURI);
    });

    $scope.conference = conference;
    $scope.process = {
      step: 'configuration'
    };

    $scope.init = function() {
      session.initialized.then(function() {
        $scope.process.step = 'conference';
      });

      session.goodbye.then(function() {
        $scope.process.step = 'goodbye';
      });
    };

    $scope.init();
  }
]).directive('liveConference', [
  '$log',
  '$timeout',
  '$interval',
  'session',
  'conferenceAPI',
  'easyRTCService',
  'currentConferenceState',
  'LOCAL_VIDEO_ID',
  'REMOTE_VIDEO_IDS',
  function($log, $timeout, $interval, session, conferenceAPI, easyRTCService, currentConferenceState, LOCAL_VIDEO_ID, REMOTE_VIDEO_IDS) {
    function controller($scope) {
      $scope.conference = session.conference;
      $scope.conferenceState = currentConferenceState;
      $scope.conferenceId = $scope.conference._id;
      $scope.reportedAttendee = null;

      $scope.$on('$locationChangeStart', function() {
        easyRTCService.leaveRoom($scope.conferenceState.conference);
      });

      $scope.showInvitation = function() {
        $('#invite').modal('show');
      };

      $scope.showReport = function(attendee) {
        $scope.reportedAttendee = attendee;
        $('#reportModal').modal('show');
      };

      $scope.onLeave = function() {
        $log.debug('Leaving the conference');
        easyRTCService.leaveRoom($scope.conferenceState.conference);
        session.leave();
      };

      $scope.invite = function(user) {
        $log.debug('Invite user', user);
        conferenceAPI.invite($scope.conferenceId, user._id).then(
          function(response) {
            $log.info('User has been invited', response.data);
          },
          function(error) {
            $log.error('Error while inviting user', error.data);
          }
        );
      };

      $scope.$on('conferencestate:attendees:push', function() {
        conferenceAPI.get($scope.conferenceId).then(function(response) {
          $scope.conferenceState.conference = response.data;
        }, function(err) {
          $log.error('Cannot get conference', $scope.conferenceId, err);
        });

        if ($scope.conferenceState.attendees.length === 2) {
          var video = $('#' + REMOTE_VIDEO_IDS[0]);
          var interval = $interval(function() {
            if (video[0].videoWidth) {
              $scope.conferenceState.updateLocalVideoIdToIndex(1);
              $scope.$apply();
              $interval.cancel(interval);
            }
          }, 100, 30, false);
        }
      });

      $scope.$on('conferencestate:attendees:remove', function(event, data) {
        conferenceAPI.get($scope.conferenceId).then(function(response) {
          $scope.conferenceState.conference = response.data;
        }, function(err) {
          $log.error('Cannot get conference', $scope.conferenceId, err);
        });

        if (data && data.videoIds === $scope.conferenceState.localVideoId) {
          $log.debug('Stream first attendee to main canvas');
          $scope.conferenceState.updateLocalVideoIdToIndex(0);
        }
      });

      // We must wait for the directive holding the template containing videoIds
      // to be displayed in the browser before using easyRTC.
      var unregisterLocalVideoWatch = $scope.$watch(function() {
        return angular.element('#' + LOCAL_VIDEO_ID)[0];
      }, function(video) {
        if (video) {
          easyRTCService.connect($scope.conferenceState);
          unregisterLocalVideoWatch();
        }
      });
    }
    return {
      restrict: 'A',
      controller: controller
    };
  }
])
.directive('liveConferenceAutoReconnect', ['easyRTCService', 'MAX_RECONNECT_TIMEOUT', '$log', '$timeout',
function(easyRTCService, MAX_RECONNECT_TIMEOUT, $log, $timeout) {
  function link($scope) {
    easyRTCService.addDisconnectCallback(function() {
      function connect() {
        easyRTCService.connect($scope.conferenceState, function(err) {
          if (err) {
            reconnectCount++;
            reconnect();
          } else {
            reconnectCount = 0;
            $('#disconnectModal').modal('hide');
          }
        });
      }

      function reconnect() {
        var delay = 1000 << reconnectCount; // jshint ignore:line

        if (delay >= MAX_RECONNECT_TIMEOUT) {
          $scope.toolong = true;
          delay = MAX_RECONNECT_TIMEOUT;
        }
        $log.info('Reconnecting in ' + delay + 'ms');
        $timeout(connect, delay);
      }

      var reconnectCount = 0;
      $scope.toolong = false;
      $('#disconnectModal').modal('show');
      reconnect();
    });
  }

  return {
    retrict: 'A',
    require: 'liveConference',
    link: link
  };

}])
.directive('liveConferenceNotification', ['$log', 'session', 'notificationFactory', 'livenotification',
  function($log, session, notificationFactory, livenotification) {
    return {
      restrict: 'E',
      link: function(scope, element, attrs) {
        function liveNotificationHandler(msg) {
          $log.debug('Got a live notification', msg);
          if (msg.user._id !== session.user._id) {
            notificationFactory.weakInfo('Conference updated!', msg.message);
          }
        }

        var socketIORoom = livenotification('/conferences', attrs.conferenceId)
          .on('notification', liveNotificationHandler);

        scope.$on('$destroy', function() {
          socketIORoom.removeListener('notification', liveNotificationHandler);
        });
      }
    };
  }
]).directive('disconnectDialog', ['$window', function($window) {
  return {
    restrict: 'E',
    replace: true,
    templateUrl: '/views/live-conference/partials/disconnect-dialog.html',
    link: function(scope) {
      scope.reloadPage = function() {
        $window.location.reload();
      };
    }
  };
}]);
