const GTop = imports.gi.GTop;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const FactoryModule = Me.imports.factory;
const Util = Me.imports.util;
const Promise = Me.imports.helpers.promise.Promise;

function MeterSubject() {
	this.observers = [];
	this.previous_usage = 0;
	this.usage = 0;

	this.add = function(object) {
		this.observers.push(object);
	};

	this.removeAt = function(index) {
		this.observers.splice(index, 1);
	};

	this.indexOf = function(object) {
		for (let i = 0; i < this.observers.length; i++) {
			if (object === this.observers[i]) {
				return i;
			}
		}

		return -1;
	};

	this.notify = function(percent, processes, system_load, directories, has_activity) {
		for (let i = 0; i < this.observers.length; i++) {
			this.observers[i].update(
				{
					percent: percent,
					processes: processes,
					system_load: system_load,
					directories: directories,
					has_activity: has_activity
				}
			);
		}
	};
};

MeterSubject.prototype.addObserver = function(observer) {
	this.add(observer);
};

MeterSubject.prototype.removeObserver = function(observer) {
	this.removeAt(this.indexOf(observer));
};

MeterSubject.prototype.notifyAll = function() {
	if (this.observers.length > 0) {
		this.previous_usage = this.usage;

		Promise.all([
			this.calculateUsage(),
			this.getProcesses(),
			this.getSystemLoad(),
			this.getDirectories(),
			this.hasActivity()
		]).then(params => {
			this.notify.apply(this, params);
		});
	}
};

/**
 * Calculate the resource usage and return a percentage value.
 */
MeterSubject.prototype.calculateUsage = function() {
	return new Promise(resolve => {
		resolve(0.0);
	});
};

/**
 * Return the list of processed associated by the measured resource.
 *
 * The returned array expected to be sorted by usage and be in descending order.
 * A process object should be like this:
 * { "command": "/path/to/binary", "id": 123 }
 */
MeterSubject.prototype.getProcesses = function() {
	return new Promise(resolve => {
		resolve([]);
	});
};

/**
 * Return information about system load.
 *
 * See the method body for expected data structure.
 */
MeterSubject.prototype.getSystemLoad = function() {
	return new Promise(resolve => {
		resolve({
			'running_tasks_count': 0,
			'tasks_count': 0,
			'load_average_1': 0,
			'load_average_5': 0,
			'load_average_15': 0
		});
	});
};

/**
 * Return the list of examined directories.
 *
 * A directory item should be like this:
 * { "name": "/tmp", "free_size": 12345 }
 * where "free_size" is in bytes.
 */
MeterSubject.prototype.getDirectories = function() {
	return new Promise(resolve => {
		resolve([]);
	});
};

/**
 * Tell wheter the resource was utilized since the last status update.
 */
MeterSubject.prototype.hasActivity = function() {
	return new Promise(resolve => {
		resolve(this.previous_usage < this.usage);
	});
};

MeterSubject.prototype.destroy = function() {};

const CpuMeter = function() {
	this.observers = [];
	this._statistics = {cpu:{}};
	let processes = new Util.Processes;
	let process_time = new GTop.glibtop_proc_time();

	this.loadData = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/proc/stat').read().then(contents => {
			let statistics = {cpu:{}};
			let reverse_data = contents.match(/^cpu.+/)[0].match(/\d+/g).reverse();
			let columns = ['user','nice','system','idle','iowait','irq','softirq','steal','guest','guest_nice'];
			for (let index in columns) {
				statistics.cpu[columns[index]] = parseInt(reverse_data.pop());
			}
			return statistics;
		});
	};

	this.calculateUsage = function() {
		return this.loadData().then(stat => {
			let periods = {cpu:{}};
			let time_calculator = function(stat) {
				let result = {};
				result.user = stat.user - stat.guest || 0;
				result.nice = stat.nice - stat.guest_nice || 0;
				result.virtall = stat.guest + stat.guest_nice || 0;
				result.systemall = stat.system + stat.irq + stat.softirq || 0;
				result.idleall = stat.idle + stat.iowait || 0;
				result.guest = stat.guest || 0;
				result.steal = stat.steal || 0;
				result.total = result.user + result.nice + result.systemall + result.idleall + stat.steal + result.virtall || 0;
				return result;
			};
			let usage_calculator = function(periods) {
				return (periods.user + periods.nice + periods.systemall + periods.steal + periods.guest) / periods.total * 100;
			};

			let times = time_calculator(stat.cpu), previous_times = time_calculator(this._statistics.cpu);
			this._statistics = stat;
			for (let index in times) {
				periods.cpu[index] = times[index] - previous_times[index];
			}

			return usage_calculator(periods.cpu);
		});
	};

	this.getProcesses = function() {
		return processes.getIds().then(process_ids => {
			let process_stats = [];
			for (let i = 0; i < process_ids.length; i++) {
				GTop.glibtop_get_proc_time(process_time, process_ids[i]);
				process_stats.push ({"pid": process_ids[i], "time": process_time.rtime});
			}

			return processes.getTopProcesses(process_stats, "time", 3);
		});
	};

	this.destroy = function() {
		FactoryModule.AbstractFactory.destroy('file', this);
	};
};

CpuMeter.prototype = new MeterSubject();


const MemoryMeter = function(calculation_method) {
	this.observers = [];
	if (-1 == ['ram_only', 'all'].indexOf(calculation_method)) {
			throw new RangeError('Unknown memory calculation method given: ' + calculation_method);
	}
	this._calculation_method = calculation_method;
	let processes = new Util.Processes;
	let process_memory = new GTop.glibtop_proc_mem();

	this.loadData = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/proc/meminfo').read().then(contents => {
			let statistics = {};
			let columns = ['memtotal','memfree','buffers','cached'];

			for (let index in columns) {
				statistics[columns[index]] = parseInt(contents.match(new RegExp(columns[index] + '.*?(\\d+)', 'i')).pop());
			}
			return statistics;
		});
	};

	this.calculateUsage = function() {
		return this.loadData().then(stat => {
			let used = stat.memtotal - stat.memfree - stat.buffers - stat.cached;
			this.usage = used / stat.memtotal * 100;
			return this.usage;
		});
	};

	this.getProcesses = function() {
		let calculation_method = this._calculation_method == 'ram_only' ? calculateRamOnly : calculateAllRam;

		return processes.getIds().then(process_ids => {
			let process_stats = [];
			for (let i = 0; i < process_ids.length; i++) {
				GTop.glibtop_get_proc_mem(process_memory, process_ids[i]);
				process_stats.push (
					{
						"pid": process_ids[i],
						"memory": calculation_method(process_memory)
					}
				);
			}

			return processes.getTopProcesses(process_stats, "memory", 3);
		});
	};

	this.destroy = function() {
		FactoryModule.AbstractFactory.destroy('file', this);
	};

	let calculateRamOnly = function(process_memory) {
		return process_memory.resident;
	};

	let calculateAllRam = function(process_memory) {
		return process_memory.vsize + process_memory.resident + process_memory.share;
	};
};

MemoryMeter.prototype = new MeterSubject();


const StorageMeter = function() {
	this.observers = [];
	let mount_entry = new RegExp('^\\S+\\s+(\\S+)\\s+(\\S+)');
	let fs_types_to_measure = [
		'btrfs', 'exfat', 'ext2', 'ext3', 'ext4', 'f2fs',
	 	'hfs', 'jfs', 'nilfs2', 'ntfs', 'reiser4', 'reiserfs', 'vfat', 'xfs',
		'zfs'
	];
	let usage = new GTop.glibtop_fsusage();
	let directories = new Util.Directories;

	this.loadData = function() {
		GTop.glibtop_get_fsusage(usage, '/');
		return (usage.blocks - usage.bavail) / usage.blocks * 100;
	}

	this.calculateUsage = function() {
		return new Promise(resolve => {
			this.usage = this.loadData();
			resolve(this.usage);
		});
	};

	this.getDirectories = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/proc/mounts').read().then(contents => {
			let mount_list = contents.split("\n");
			mount_list.splice(-2);	// remove the last two empty lines
			let directory_stats = [];
			for (let i = 0; i < mount_list.length; i++) {
				[, mount_dir, fs_type] = mount_list[i].match(mount_entry);
				if (fs_types_to_measure.indexOf(fs_type) == -1) {
					continue;
				}
				GTop.glibtop_get_fsusage(usage, mount_dir);
				directory_stats.push({
					'name': mount_dir,
					'free_size': usage.bavail * usage.block_size
				});
			}

			return directories.getTopDirectories(directory_stats, 'free_size', 3);
		});

	};
};

StorageMeter.prototype = new MeterSubject();


const NetworkMeter = function() {
	this.observers = [];
	this._statistics = {};
	this._bandwidths = {};

	this.loadData = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/sys/class/net').list().then(files => {
			let statistics = {};
			let promises = [];
			for (let device_name of files) {
				let promise = FactoryModule.AbstractFactory.create('file', this, '/sys/class/net/' + device_name + '/operstate').read().then(contents => {
					if (contents.trim() == 'up') {
						statistics[device_name] = {};

						let receive_promise = FactoryModule.AbstractFactory.create('file', this, '/sys/class/net/' + device_name + '/statistics/rx_bytes').read().then(contents => {
							return parseInt(contents);
						});

						let transmit_promise = FactoryModule.AbstractFactory.create('file', this, '/sys/class/net/' + device_name + '/statistics/tx_bytes').read().then(contents => {
							return parseInt(contents);
						});

						return Promise.all([receive_promise, transmit_promise]).then(bytes => {
							statistics[device_name].rx_bytes = bytes[0];
							statistics[device_name].tx_bytes = bytes[1];
						});
					}
					return false;
				});
				promises.push(promise);
			}

			return Promise.all(promises).then(() => {
				return statistics;
			});
		});
	};

	this.calculateUsage = function() {
		return this.loadData().then(statistics => {
			let calculate_speeds = function(statistics) {
				let speeds = {};
				for (let index in statistics) {
					speeds[index] = {};
					speeds[index].upload = statistics[index].tx_bytes - (this._statistics[index] != undefined ? this._statistics[index].tx_bytes : statistics[index].tx_bytes);
					speeds[index].download = statistics[index].rx_bytes - (this._statistics[index] != undefined ? this._statistics[index].rx_bytes : statistics[index].rx_bytes);
				}
				return speeds;
			};
			let calculate_bandwidths = function(speeds) {
				let bandwidths = {};
				for (let index in speeds) {
					let speed = speeds[index];
					bandwidths[index] = {};
					bandwidths[index].upload = Math.max(speed.upload, (this._bandwidths[index] != undefined ? this._bandwidths[index].upload : 1));
					bandwidths[index].download = Math.max(speed.download, (this._bandwidths[index] != undefined ? this._bandwidths[index].download : 1));
				}
				return bandwidths;
			};
			let calculate_interface_usages = function(speeds) {
				let usages = {};
				for (let index in speeds) {
					let speed = speeds[index];
					let upload_rate = this._bandwidths[index] != undefined ? speed.upload / this._bandwidths[index].upload : 0;
					let download_rate = this._bandwidths[index] != undefined ? speed.download / this._bandwidths[index].download : 0;
					usages[index] = Math.round(Math.max(upload_rate, download_rate) * 100);
				}
				return usages;
			}

			let speeds = calculate_speeds.call(this, statistics);
			this._bandwidths = calculate_bandwidths.call(this, speeds);
			let usages = calculate_interface_usages.call(this, speeds);
			let sum_percent = 0;
			for (let index in usages) {
				sum_percent += usages[index];
			}
			let total = Object.keys(usages).length * 100 || 1;

			this._statistics = statistics;

			this.usage = Math.round(sum_percent / total * 100);
			return this.usage;
		});
	};

	this.destroy = function() {
		FactoryModule.AbstractFactory.destroy('file', this);
	};
};

NetworkMeter.prototype = new MeterSubject();


const SwapMeter = function() {
	this.observers = [];
	let swap_utility = new Util.Swap;
	let processes = new Util.Processes;

	this.loadData = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/proc/meminfo').read().then(contents => {
			let statistics = {};
			let columns = ['swaptotal','swapfree'];

			for (let index in columns) {
				statistics[columns[index]] = parseInt(contents.match(new RegExp(columns[index] + '.*?(\\d+)', 'i')).pop());
			}
			return statistics;
		});
	};

	this.calculateUsage = function() {
		return this.loadData().then(stat => {
			let used = stat.swaptotal - stat.swapfree;
			this.usage = stat.swaptotal == 0 ? 0 : used / stat.swaptotal * 100;
			return this.usage;
		});
	};

	this.getProcesses = function() {
		return swap_utility.getStatisticsPerProcess().then(raw_statistics => {
			let process_stats = [];
			for (let pid in raw_statistics) {
				if (raw_statistics[pid].vm_swap > 0) {
					process_stats.push(
						{
							"pid": pid,
							"memory": raw_statistics[pid].vm_swap
						}
					);
				}
			}

			return processes.getTopProcesses(process_stats, "memory", 3);
		});
	};

	this.destroy = function() {
		FactoryModule.AbstractFactory.destroy('file', this);
	};
};

SwapMeter.prototype = new MeterSubject();


const SystemLoadMeter = function() {
	this.observers = [];
	this._number_of_cpu_cores = null;
	let load = new GTop.glibtop_loadavg();

	this._getNumberOfCPUCores = function() {
		return new Promise(resolve => {
			if (this._number_of_cpu_cores !== null) {
				return resolve(this._number_of_cpu_cores);
			}

			FactoryModule.AbstractFactory.create('file', this, '/proc/cpuinfo').read().then(contents => {
				this._number_of_cpu_cores = contents.match(new RegExp('^processor', 'gm')).length;
				resolve(this._number_of_cpu_cores);
			});

			return false;
		});
	};

	this.loadData = function() {
		return FactoryModule.AbstractFactory.create('file', this, '/proc/loadavg').read().then(contents => {
			let statistics = {};
			let reverse_data = contents.split(' ').reverse();
			let columns = ['oneminute'];

			for (let index in columns) {
				statistics[columns[index]] = parseFloat(reverse_data.pop());
			}
			return statistics;
		});
	};

	this.calculateUsage = function() {
		return this.loadData().then(stat => {
			return this._getNumberOfCPUCores().then(count => {
				this.usage = stat.oneminute / count * 100;
				this.usage = this.usage > 100 ? 100 : this.usage;
				return this.usage;
			});
		});
	};

	this.getSystemLoad = function() {
		return new Promise(resolve => {
			GTop.glibtop_get_loadavg(load);
			resolve({
				'running_tasks_count': load.nr_running,
				'tasks_count': load.nr_tasks,
				'load_average_1': load.loadavg[0],
				'load_average_5': load.loadavg[1],
				'load_average_15': load.loadavg[2]
			});
		});
	};

	this.destroy = function() {
		FactoryModule.AbstractFactory.destroy('file', this);
	};
};

SystemLoadMeter.prototype = new MeterSubject();
