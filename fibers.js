if (process.fiberLib) {
	module.exports = process.fiberLib;
} else {
	var fs = require('fs'), path = require('path'), detectLibc = require('detect-libc');

	// Seed random numbers [gh-82]
	Math.random();

	// Look for binary for this platform
	var modPath = path.join(__dirname, 'bin', process.platform+ '-'+ process.arch+ '-'+ process.versions.modules+
		((process.platform === 'linux') ? '-'+ detectLibc.family : ''), 'fibers');
	try {
		// Pull in fibers implementation
		process.fiberLib = module.exports = require(modPath).Fiber;
	} catch (ex) {
		// No binary!
		console.error(
			'## There is an issue with `node-fibers` ##\n'+
			'`'+ modPath+ '.node` is missing.\n\n'+
			'Try running this to fix the issue: '+ process.execPath+ ' '+ __dirname.replace(' ', '\\ ')+ '/build'
		);
		console.error(ex.stack || ex.message || ex);
		throw new Error('Missing binary. See message above.');
	}

	setupAsyncHacks(module.exports);
}

function setupAsyncHacks(Fiber) {
	// Older (or newer?) versions of node may not support this API
	try {
		var aw = process.binding('async_wrap');
		var ah = require('async_hooks');
		var getAsyncIdStackSize;

		if (aw.asyncIdStackSize instanceof Function) {
			getAsyncIdStackSize = aw.asyncIdStackSize;
		} else if (aw.constants.kStackLength !== undefined) {
			getAsyncIdStackSize = function(kStackLength) {
				return function() {
					return aw.async_hook_fields[kStackLength];
				};
			}(aw.constants.kStackLength);
		} else {
			throw new Error('Couldn\'t figure out how to get async stack size');
		}

		var popAsyncContext = aw.popAsyncContext || aw.popAsyncIds;
		var pushAsyncContext = aw.pushAsyncContext || aw.pushAsyncIds;
		if (!popAsyncContext || !pushAsyncContext) {
			throw new Error('Push/pop do not exist');
		}

		var kExecutionAsyncId;
		if (aw.constants.kExecutionAsyncId === undefined) {
			kExecutionAsyncId = aw.constants.kCurrentAsyncId;
		} else {
			kExecutionAsyncId = aw.constants.kExecutionAsyncId;
		}
		var kTriggerAsyncId;
		if (aw.constants.kTriggerAsyncId === undefined) {
			kTriggerAsyncId = aw.constants.kCurrentTriggerId;
		} else {
			kTriggerAsyncId = aw.constants.kTriggerAsyncId;
		}

		var asyncIds = aw.async_id_fields || aw.async_uid_fields;

		function getAndClearStack() {
			var ii = getAsyncIdStackSize();
			var stack = new Array(ii);
			for (; ii > 0; --ii) {
				var asyncId = asyncIds[kExecutionAsyncId];
				stack[ii - 1] = {
					asyncResource: ah.executionAsyncResource(),
					asyncId: asyncId,
					triggerId: asyncIds[kTriggerAsyncId],
				};
				popAsyncContext(asyncId);
			}
			return stack;
		}

		function restoreStack(stack) {
			for (var ii = 0; ii < stack.length; ++ii) {
				pushAsyncContext(stack[ii].asyncId, stack[ii].triggerId);
				aw.execution_async_resources.push(stack[ii].asyncResource);
			}
		}

		function logUsingFibers(fibersMethod) {
			const logUseFibersLevel = +(process.env.ENABLE_LOG_USE_FIBERS || 0);

			if (!logUseFibersLevel) return;

			if (logUseFibersLevel === 1) {
				console.warn(`[FIBERS_LOG] Using ${fibersMethod}.`);
				return;
			}

			const { LOG_USE_FIBERS_INCLUDE_IN_PATH } = process.env;
			const stackFromError = new Error(`[FIBERS_LOG] Using ${fibersMethod}.`).stack;

			if (
				!LOG_USE_FIBERS_INCLUDE_IN_PATH ||
				stackFromError.includes(LOG_USE_FIBERS_INCLUDE_IN_PATH)
			) {
				console.warn(stackFromError);
			}
		}

		function wrapFunction(fn, fibersMethod) {
			return function () {
				logUsingFibers(fibersMethod);
				var stack = getAndClearStack();
				try {
					return fn.apply(this, arguments);
				} finally {
					restoreStack(stack);
				}
			};
		}

		// Monkey patch methods which may long jump
		Fiber.yield = wrapFunction(Fiber.yield, "Fiber.yield");
		Fiber.prototype.run = wrapFunction(Fiber.prototype.run, "Fiber.run");
		Fiber.prototype.throwInto = wrapFunction(
			Fiber.prototype.throwInto,
			"Fiber.throwInto"
		);

	} catch (err) {
		return;
	}
}
