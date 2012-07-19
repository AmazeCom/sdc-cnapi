/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');
var restify = require('restify');
var common = require('./job-common');


function validateParams(job, cb) {
    console.log(job.params);

    if (!job.params['napi_url'] || !job.params['napi_username'] ||
        !job.params['napi_password'])
        return cb('No NAPI parameters provided');

    if (!job.params['cnapi_url'])
        return cb('No CNAPI URL provided');

    if (!job.params['dapi_url'])
        return cb('No DAPI URL provided');

    if (!job.params.owner_uuid)
        return cb('\'owner_uuid\' is required');

    if (!job.params.image_uuid)
        return cb('\'image_uuid\' is required');

    if (!job.params.brand)
        return cb('VM \'brand\' is required');

    if (!job.params.ram)
        return cb('VM \'ram\' is required');

    if (job.params.vm_uuid) {
        job.params.uuid = job.params.vm_uuid;
    }

    return cb(null, 'All parameters OK!');
}



function getServers(job, cb) {
    if (job.params.server_uuid) {
        return cb(null, 'Server UUID present, ' +
            'no need to get servers from CNAPI');
    }

    var cnapi = restify.createJsonClient({ url: job.params['cnapi_url'] });

    return cnapi.get('/servers', function (err, req, res, servers) {
        if (err) {
            return cb(err);
        } else {
            if (Array.isArray(servers) && servers.length) {
                job.servers = servers;
                return cb(null, 'Got servers!');
            } else {
                return cb(new Error('No servers found on CNAPI'));
            }
        }
    });
}



function getAllocation(job, cb) {
    if (job.params.server_uuid) {
        return cb(null, 'Server UUID present, ' +
            'no need to get allocation from DAPI');
    }

    var dapi = restify.createJsonClient({ url: job.params['dapi_url'] });

    var payload = {
        servers: job.servers,
        vm: { ram: job.params.ram }
    };

    return dapi.post('/allocation', payload,
      function (err, req, res, server) {
          if (err) {
              return cb(err);
          } else {
              job.params.server_uuid = server.uuid;
              return cb(null, 'Server allocated!');
          }
    });
}


function getNICs(job, cb) {
    var networks = job.params.networks;
    var nics = job.params.nics;

    if (!networks && !nics)
        return cb('Networks or NICs are required');

    var napi = restify.createJsonClient({ url: job.params['napi_url'] });
    napi.basicAuth(job.params['napi_username'], job.params['napi_password']);

    job.params.nics = [];
    var params = {
        owner_uuid: job.params.owner_uuid,
        belongs_to_uuid: job.params.uuid,
        belongs_to_type: 'zone'
    };

    var length;
    if (networks)
        length = networks.length;
    else
        length = nics.length;

    for (var i = 0; i < length; i++) {
        var path, theNic;

        if (networks) {
            path = '/networks/' + networks[i] + '/nics';
            theNic = params;
        } else {
            path = '/nics';
            theNic = nics[i];
            theNic.owner_uuid = job.params.owner_uuid;
            theNic.belongs_to_uuid = job.params.uuid;
            theNic.belongs_to_type = 'zone';
        }

        napi.post(path, theNic, function (err, req, res, nic) {
            if (err) {
                return cb(err);
            } else {
                job.params.nics.push(nic);

                if (job.params.nics.length == length)
                    return cb(null, 'NICs allocated!');
                return (null);
            }
        });
    }

    return (null);
}



function provision(job, cb) {
    var cnapi = restify.createJsonClient({ url: job.params['cnapi_url'] });
    var endpoint = '/servers/' + job.params.server_uuid + '/vms';
    job.params.jobid = job.uuid;

    return cnapi.post(endpoint, job.params, function (err, req, res, task) {
      if (err) {
          return cb(err);
      } else {
          job.taskId = task.id;
          return cb(null, 'Provision queued!');
      }
    });
}



var workflow = module.exports = {
    name: 'provision-cnapi-' + uuid(),
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: validateParams
    }, {
        name: 'cnapi.get_servers',
        timeout: 10,
        retry: 1,
        body: getServers
    }, {
        name: 'dapi.get_allocation',
        timeout: 10,
        retry: 1,
        body: getAllocation
    }, {
        name: 'napi.provision_nics',
        timeout: 10,
        retry: 1,
        body: getNICs
    }, {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_state',
        timeout: 30,
        retry: 1,
        body: common.checkState
    }],
    timeout: 240,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
