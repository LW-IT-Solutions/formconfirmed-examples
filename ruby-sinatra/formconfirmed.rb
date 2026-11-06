# frozen_string_literal: true

# Minimal formconfirmed client: ask /v1/verify and turn the answer into a decision.
#
# Outage rule: anything that is not a clear answer of the service is never a pass.
# No answer, a timeout, an HTTP error, an unknown answer, an error code that means
# "no check took place", or a token in which the visitor's browser only *claims*
# that the service was unreachable (reason service_unavailable) - all of these are
# "unavailable". Such a message is delivered only if an independent check of your
# own application passed; otherwise it is held for review.
#
# Standard library only (net/http, json).

require 'json'
require 'net/http'
require 'timeout'
require 'uri'

module Formconfirmed
  FIELD = 'fcp-response'   # hidden field with the token (added by the widget)
  HONEYPOT = 'fcp-website' # trap field (added by the widget)
  PURPOSE = 'contact'      # must match data-purpose of the widget
  TIMEOUT = 5              # seconds, never more

  # Error codes that mean "no check took place" (not the visitor's fault).
  NO_CHECK_CODES = %w[service-disabled site-paused invalid-input-secret missing-input-secret bad-request].freeze

  Result = Struct.new(:action, :unavailable, :score, :reasons, :codes, keyword_init: true)

  module_function

  def config
    {
      api: (ENV['FORMCONFIRMED_API'].to_s.empty? ? 'https://formconfirmed.com/v1' : ENV['FORMCONFIRMED_API']).sub(%r{/+\z}, ''),
      sitekey: ENV.fetch('FORMCONFIRMED_SITEKEY', ''),
      secret: ENV.fetch('FORMCONFIRMED_SECRET', '')
    }
  end

  # fields: response, hp, remoteip and optionally email, name, content.
  def verify(cfg, fields)
    body = {
      'secret' => cfg[:secret],
      'response' => fields[:response].to_s.byteslice(0, 4000).scrub(''),
      'hp' => fields[:hp].to_s.byteslice(0, 2048).scrub(''),
      'remoteip' => fields[:remoteip].to_s,
      'expected_purpose' => PURPOSE,
      'form_mode' => 'interactive'
    }
    %i[email name content].each { |k| body[k.to_s] = fields[k].to_s unless fields[k].to_s.empty? }

    uri = URI(cfg[:api] + '/verify')
    status = 0
    text = ''
    begin
      Timeout.timeout(TIMEOUT) do
        res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https',
                                                  open_timeout: TIMEOUT, read_timeout: TIMEOUT, write_timeout: TIMEOUT) do |http|
          http.post(uri.request_uri, URI.encode_www_form(body), 'Content-Type' => 'application/x-www-form-urlencoded')
        end
        status = res.code.to_i
        text = res.body.to_s
      end
    rescue StandardError, Timeout::Error
      status = 0 # network error or timeout
    end
    read_answer(status, text)
  end

  # status 0 = no answer.
  def read_answer(status, body)
    none = Result.new(action: 'none', unavailable: true, score: nil, reasons: [],
                      codes: [status.zero? ? 'no-answer' : "http-#{status}"])
    return none unless status == 200

    j = begin
      JSON.parse(body)
    rescue JSON::ParserError
      nil
    end
    unless j.is_a?(Hash) && j['action'].is_a?(String)
      none.codes = ['invalid-answer']
      return none
    end
    strings = ->(v) { Array(v).grep(String) }
    codes = strings.call(j['error-codes'])
    reasons = strings.call(j['reasons'])
    no_check = codes & NO_CHECK_CODES
    unless no_check.empty?
      none.codes = no_check
      return none
    end
    if !%w[allow flag block].include?(j['action']) || (j['action'] == 'allow' && j['success'] != true)
      none.codes = ['invalid-answer']
      return none
    end
    Result.new(
      action: j['action'],
      # The browser could not reach the service: an unsigned claim, not a check.
      unavailable: j['action'] != 'block' && reasons.include?('service_unavailable'),
      score: j['score'].is_a?(Numeric) ? j['score'].to_f : nil,
      reasons: reasons,
      codes: codes
    )
  end

  # :deliver, :hold or :reject. The block is your own check that does not depend on formconfirmed.
  def decide(result, &independent_check)
    return :reject if result.action == 'block'
    return(independent_check.call ? :deliver : :hold) if result.unavailable
    return :hold if result.action == 'flag' # flag is never a pass

    result.action == 'allow' ? :deliver : :hold
  end
end
