'use strict';

exports.activate = function (context) {
  context.exports.scanAttachments = function () {
    context.ui.openPanel('scan');
    return { opened: true };
  };
};

exports.deactivate = function () {};
